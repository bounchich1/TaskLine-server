import { randomUUID } from 'node:crypto';
import { readConfig } from './config.js';
import { Postgres, migrate, one } from './db.js';
import { seed } from './seed.js';
import { audit } from './events.js';
import { MaxClient } from './max/client.js';
import { ensure } from './errors.js';
import { Memory } from './ai/memory.js';
const c=readConfig();const db=new Postgres(c.DATABASE_URL);
try {
  const command=process.argv[2];
  if(command==='migrate') {await migrate(db);await seed(db,c);console.log('Schema and reserved defaults ready.');}
  else if(command==='bootstrap') {
    ensure(/^\d{1,20}$/.test(c.BOOTSTRAP_MAX_USER_ID),'bootstrap_id_required',422);
    await db.tx(async tx=> {
      await tx.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE',[c.ORG_ID]);
      const existing=await one(tx,"SELECT id FROM employees WHERE org_id=$1 AND role='admin' AND NOT blocked",[c.ORG_ID]);
      ensure(!existing,'admin_already_exists',409,'Use authenticated administration after initial bootstrap.');
      const id=randomUUID();await tx.query("INSERT INTO employees(id,org_id,max_user_id,name,role) VALUES($1,$2,$3,$4,'admin')",[id,c.ORG_ID,c.BOOTSTRAP_MAX_USER_ID,c.BOOTSTRAP_NAME]);
      await audit(tx,c.ORG_ID,null,'admin.bootstrap',id);
    });console.log('Initial administrator created.');
  } else if(command==='subscribe') {
    ensure(c.MAX_MODE==='live'&&new URL(c.PUBLIC_URL).protocol==='https:','https_live_required',422);
    await new MaxClient(c).request('/subscriptions',{url:`${c.PUBLIC_URL}/webhooks/max`,secret:c.MAX_WEBHOOK_SECRET,update_types:['message_created','message_edited','message_removed','message_callback','bot_started']});console.log('Webhook subscription registered.');
  } else if(command==='memory-reconcile') {const id=process.argv[3];ensure(id,'record_id_required',422);await new Memory(db,c).reconcile(id);console.log('Memory reconciliation completed.');}
  else if(command==='permit-resolve') {
    const slot=Number(process.argv[3]);const evidence=process.argv[4];ensure(Number.isInteger(slot)&&slot>=1&&slot<=15&&evidence?.length>=20,'provider_evidence_required',422);
    await db.tx(async tx=> {
      const permit=await one(tx,'SELECT * FROM ai_permits WHERE slot=$1 FOR UPDATE',[slot]);ensure(permit?.state==='uncertain','permit_not_uncertain');
      await audit(tx,c.ORG_ID,null,'ai.permit.resolved',String(slot),{evidence,holder:permit.holder});
      await tx.query("UPDATE ai_calls SET state='failed',reason='operator_confirmed_ended',finished_at=now() WHERE id=$1",[permit.holder]);
      await tx.query("UPDATE ai_permits SET state='free',holder=NULL,started_at=NULL WHERE slot=$1",[slot]);
    });console.log('Permit released using recorded operator evidence.');
  } else if(command==='ai-cap') {
    const cap=Number(process.argv[3]);ensure(Number.isInteger(cap)&&cap>=10&&cap<=15,'invalid_cap',422);
    await db.tx(async tx=> {await tx.query('SELECT id FROM ai_settings WHERE id=1 FOR UPDATE');const busy=await one(tx,"SELECT count(*)::int AS n FROM ai_permits WHERE state<>'free'");ensure(Number(busy!.n)<=cap,'drain_required');await tx.query('UPDATE ai_settings SET cap=$1 WHERE id=1',[cap]);await audit(tx,c.ORG_ID,null,'ai.cap.changed','1',{cap});});console.log('Global AI cap updated.');
  } else throw new Error('Commands: migrate, bootstrap, subscribe, memory-reconcile <id>, permit-resolve <slot> <evidence>, ai-cap <10..15>');
} finally {await db.close();}
