import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileTypeFromFile } from 'file-type';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Config } from './config.js';
import { one, type Database } from './db.js';
import { decrypt } from './crypto.js';
import { ensure } from './errors.js';
import { emit, enqueue } from './events.js';
import { mediaFetch } from './network.js';
import type { Employee, InputAttachment, Row, Ticket } from './types.js';

type Attachment = Row & {id:string;ticket_id:string;message_id:string|null;owner_id:string|null;kind:string;filename:string;status:string;object_key:string|null;source_ref:string|null;mime:string|null;bytes:string;sha256:string|null};
export const safeFilename = (name: string) => name.replace(/[\\/\r\n\x00-\x1f"<>:|?*]/g,'_').slice(0,160) || 'attachment';
const limitFor = (kind: string) => (kind==='video'?100:kind==='image'?20:25)*1024*1024;

export class Files {
  private s3?: S3Client;
  constructor(readonly db: Database, readonly c: Config) {
    if (c.STORAGE_MODE==='s3') this.s3 = new S3Client({region:c.S3_REGION,endpoint:c.S3_ENDPOINT,forcePathStyle:!!c.S3_ENDPOINT,credentials:{accessKeyId:c.S3_ACCESS_KEY_ID,secretAccessKey:c.S3_SECRET_ACCESS_KEY}});
  }
  private path(key: string) {
    ensure(/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key),'invalid_object_key',500);
    return resolve(this.c.STORAGE_PATH,key);
  }
  private async put(key: string, path: string, mime: string) {
    if (this.s3) await this.s3.send(new PutObjectCommand({Bucket:this.c.S3_BUCKET,Key:key,Body:createReadStream(path),ContentType:mime,ContentLength:(await stat(path)).size,ServerSideEncryption:'AES256'}));
    else { const target=this.path(key); await mkdir(resolve(target,'..'),{recursive:true}); await pipeline(createReadStream(path),createWriteStream(target,{flags:'w',mode:0o600})); }
  }
  async read(key: string): Promise<Readable> {
    if (this.s3) { const result=await this.s3.send(new GetObjectCommand({Bucket:this.c.S3_BUCKET,Key:key})); ensure(result.Body,'object_missing',404); return result.Body as Readable; }
    return createReadStream(this.path(key));
  }
  async remove(key: string) {
    if (this.s3) await this.s3.send(new DeleteObjectCommand({Bucket:this.c.S3_BUCKET,Key:key}));
    else await rm(this.path(key),{force:true});
  }
  async prepare(employee: Employee, ticketId: string, filename: string, kind: string) {
    return this.db.tx(async tx=> {
      const ticket = await one<Ticket>(tx,'SELECT * FROM tickets WHERE org_id=$1 AND id=$2 FOR UPDATE',[this.c.ORG_ID,ticketId]); ensure(ticket,'not_found',404);
      ensure(ticket.status==='in_progress' && (ticket.assignee_id===employee.id || employee.role!=='support'),'forbidden',403);
      const row = await one(tx,"INSERT INTO attachments(org_id,ticket_id,owner_id,filename,kind) VALUES($1,$2,$3,$4,$5) RETURNING id,status",[this.c.ORG_ID,ticketId,employee.id,safeFilename(filename),kind]); return row;
    });
  }
  async receive(employee: Employee, id: string, stream: Readable, isTruncated: ()=>boolean = ()=>false) {
    const row = await this.db.tx(async tx=> {
      const file=await one<Attachment>(tx,"SELECT * FROM attachments WHERE id=$1 AND org_id=$2 AND owner_id=$3 AND message_id IS NULL AND status='uploading' AND expires_at>now() FOR UPDATE",[id,this.c.ORG_ID,employee.id]); ensure(file,'invalid_upload',409);
      await tx.query("UPDATE attachments SET status='receiving' WHERE id=$1",[id]); return file;
    });
    try { await this.storeStream(row,stream,isTruncated); }
    catch (error) { await this.db.query("UPDATE attachments SET status='failed' WHERE id=$1",[id]); throw error; }
    return {id,status:'quarantined'};
  }
  private async storeStream(file: Attachment, stream: Readable, isTruncated: ()=>boolean = ()=>false) {
    const temp = await mkdtemp(join(tmpdir(),'max-file-')); const path = join(temp,'body'); let bytes=0; const digest = createHash('sha256');
    try {
      await pipeline(stream,new Transform({transform(chunk:Buffer,_encoding,callback){ bytes+=chunk.length; digest.update(chunk); if (bytes>limitFor(file.kind)) callback(new Error('file_too_large')); else callback(null,chunk); }}),createWriteStream(path,{mode:0o600}));
      ensure(bytes>0 && !isTruncated(),'invalid_file',422);
      const key=`${this.c.ORG_ID}/${file.id}`;
      await this.put(key,path,'application/octet-stream');
      await this.db.tx(async tx=> {
        const changed = await tx.query("UPDATE attachments SET object_key=$2,bytes=$3,sha256=$4,status='quarantined' WHERE id=$1 AND status IN('receiving','pending') RETURNING id",[file.id,key,bytes,digest.digest('hex')]);
        if (changed.rows.length) await enqueue(tx,this.c.ORG_ID,`scan:${file.id}`,'scan',file.id);
      });
    } finally { await rm(temp,{recursive:true,force:true}); }
  }
  async downloadInbound(id: string) {
    const file=await one<Attachment>(this.db,'SELECT * FROM attachments WHERE org_id=$1 AND id=$2',[this.c.ORG_ID,id]);
    if (!file || file.status!=='pending') return;
    const consent=await one(this.db,"SELECT t.id FROM tickets t JOIN clients c ON c.id=t.client_id WHERE t.id=$1 AND c.consent_state='granted' AND c.consent_revision=t.consent_revision",[file.ticket_id]);
    if (!consent) { await this.db.query("UPDATE attachments SET status='canceled',source_ref=NULL WHERE id=$1",[id]); return; }
    const source=decrypt<InputAttachment>(file.source_ref!,this.c.ENCRYPTION_KEY);
    if (!source.url) { await this.db.query("UPDATE attachments SET status='unavailable' WHERE id=$1",[id]); return; }
    const media=await mediaFetch(source.url,this.c.MAX_MEDIA_HOSTS.split(',').map(h=>h.trim()).filter(Boolean));
    try {
      ensure(media.response.ok && media.response.body,'media_unavailable',503);
      const size=Number(media.response.headers.get('content-length')); ensure(!size || size<=limitFor(file.kind),'file_too_large',422);
      await this.storeStream(file,Readable.fromWeb(media.response.body as never));
    } finally { await media.close(); }
  }
  async scan(id: string) {
    const file=await one<Attachment>(this.db,'SELECT * FROM attachments WHERE org_id=$1 AND id=$2',[this.c.ORG_ID,id]);
    if (!file || file.status!=='quarantined' || !file.object_key) return;
    const temp=await mkdtemp(join(tmpdir(),'max-scan-')); const path=join(temp,'body');
    try {
      await pipeline(await this.read(file.object_key),createWriteStream(path,{mode:0o600}));
      const mime=await fileTypeFromFile(path);
      let contentType=mime?.mime ?? '';
      if (!mime && file.filename.toLowerCase().endsWith('.txt')) {
        const sample=await readFile(path); ensure(!sample.includes(0),'unsupported_file',422); contentType='text/plain';
      }
      const allowed = contentType.startsWith('image/') && !['image/svg+xml'].includes(contentType) || contentType.startsWith('video/') || ['application/pdf','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/msword','application/vnd.ms-excel'].includes(contentType);
      if (!allowed || file.kind==='image'&&!contentType.startsWith('image/') || file.kind==='video'&&!contentType.startsWith('video/')) {
        await this.db.query("UPDATE attachments SET status='rejected',extraction_status='unsupported' WHERE id=$1",[id]); return;
      }
      const clean = this.c.SCANNER_MODE==='mock' ? !(await readFile(path)).includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') : await clamScan(path,this.c.CLAMAV_HOST,this.c.CLAMAV_PORT);
      if (!clean) { await this.db.query("UPDATE attachments SET status='infected' WHERE id=$1",[id]); return; }
      const text=contentType==='text/plain' ? (await readFile(path,'utf8')) : null;
      const extracted=text===null?null:text.slice(0,32000); const coverage=text===null?'unsupported':text.length>32000?'partial':'complete';
      await this.db.tx(async tx=> {
        const eligible=await one(tx,"SELECT t.id FROM tickets t JOIN clients c ON c.id=t.client_id WHERE t.id=$1 AND c.consent_state='granted' AND c.consent_revision=t.consent_revision",[file.ticket_id]);
        if (!eligible) { await tx.query("UPDATE attachments SET status='canceled' WHERE id=$1",[id]); return; }
        await tx.query("UPDATE attachments SET status='clean',mime=$2,extraction=$3,extraction_status=$4,source_ref=NULL WHERE id=$1",[id,contentType,extracted,coverage]);
        await emit(tx,this.c.ORG_ID,'attachment.changed',file.ticket_id,{attachment_id:id,status:'clean'});
      });
    } finally { await rm(temp,{recursive:true,force:true}); }
  }
  async materialize(id: string) {
    const file=await one<Attachment>(this.db,"SELECT * FROM attachments WHERE org_id=$1 AND id=$2 AND status='clean'",[this.c.ORG_ID,id]); ensure(file?.object_key,'attachment_not_ready',422);
    const temp=await mkdtemp(join(tmpdir(),'max-outbound-')); const path=join(temp,'body');
    try { await pipeline(await this.read(file.object_key),createWriteStream(path,{mode:0o600})); }
    catch(error) {await rm(temp,{recursive:true,force:true});throw error;}
    return {path,kind:file.kind,filename:safeFilename(file.filename),mime:file.mime ?? 'application/octet-stream',cleanup:()=>rm(temp,{recursive:true,force:true})};
  }
}

async function clamScan(path: string, host: string, port: number): Promise<boolean> {
  const socket=new Socket(); const result=new Promise<boolean>((resolve,reject)=> {
    let response=''; socket.setTimeout(60000,()=>socket.destroy(new Error('scanner_timeout')));
    socket.on('error',reject); socket.on('data',chunk=>{response+=chunk.toString(); if(response.length>4096) socket.destroy(new Error('scanner_invalid_response'));});
    socket.on('end',()=> { if (/stream: OK/.test(response)) resolve(true); else if (/FOUND/.test(response)) resolve(false); else reject(new Error('scanner_unavailable')); });
  });
  try {
    await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.connect(port,host,resolve);});
    socket.write('zINSTREAM\0');
    for await (const chunk of createReadStream(path,{highWaterMark:64*1024})) {
      const bytes=chunk as Buffer; const size=Buffer.alloc(4);size.writeUInt32BE(bytes.length);socket.write(size);
      if(!socket.write(bytes)) await new Promise<void>(resolve=>socket.once('drain',resolve));
    }
    socket.write(Buffer.alloc(4)); return await result;
  } finally { socket.destroy(); void result.catch(()=>{}); }
}

export async function writeTestText(path: string, content: string) { await writeFile(path,content); }
