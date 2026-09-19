import { readConfig } from './config.js';
import { Postgres } from './db.js';
import { buildApi } from './api.js';
import { buildGateway } from './ai/gateway.js';
import { startWorkers } from './workers.js';
const c=readConfig();const db=new Postgres(c.DATABASE_URL);const role=process.argv[2] ?? 'api';
const cleanups:(()=>Promise<unknown>)[]=[];
if(role==='gateway'||role==='all') {
  if(c.AI_ENABLED&&c.AI_MODE==='live'&&(!c.AI_API_KEY||!c.AI_MODEL))throw new Error('Configure AI_API_KEY and AI_MODEL in gateway environment');
  const gateway=await buildGateway(db,c);await gateway.listen({host:c.HOST,port:c.GATEWAY_PORT});cleanups.push(()=>gateway.close());
}
if(role==='api'||role==='all') {const api=await buildApi(db,c);await api.listen({host:c.HOST,port:c.PORT});cleanups.push(()=>api.close());}
if(role==='worker'||role==='all') cleanups.push(await startWorkers(db,c));
if(!['api','worker','gateway','all'].includes(role))throw new Error('Unknown process role');
let stopping=false;
const shutdown=async()=>{if(stopping)return;stopping=true;for(const close of cleanups.reverse())await close();await db.close();};
process.on('SIGINT',()=>{void shutdown();});process.on('SIGTERM',()=>{void shutdown();});
