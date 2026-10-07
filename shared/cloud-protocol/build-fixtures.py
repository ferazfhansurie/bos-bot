"""Regenerate fictional, language-neutral protocol vectors (no runtime dependency)."""
import json, hashlib
from pathlib import Path
root=Path(__file__).parent
ns=dict(service='cloud-local',issuer='stub',subject='alice',account_id='alice',workspace_id='w1',epoch='e1')
env=dict(kind='message.send',namespace=ns,client_operation_id='window1.abcdefghijklmnop',window_token='fixture.signature',room_id='r1',thread_id='t1',text='hello 👋 @bob\nexact  ',mentions=[dict(kind='human',id='bob',start=9,end=13)],attachment_ids=[],reply_to_message_id=None,expected_policy_revision='1')
def digest(e): return hashlib.sha256(json.dumps(e,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
def msg(n,text='hello',actor='bob',thread='t1'):
 return dict(workspace_id='w1',room_id='r1',thread_id=thread,message_id=f'm{n}',actor_id=actor,client_operation_id=f'window1.operation{n:016d}',sequence=str(n),version=1,text=text,mentions=[],reply_to_message_id=None,deleted=False,created_at='2026-10-07T00:00:00.000Z')
def event(n,kind='message.created',required=True,version=1,thread='t1'):
 return dict(schema_version=version,workspace_id='w1',room_id='r1',event_id=f'ev{n}',sequence=str(n),kind=kind,required=required,payload=dict(message=msg(n,thread=thread)))
def batch(events,scanned,live=True):
 return dict(type='event_batch',workspace_id='w1',room_id='r1',events=events,cursor=f'cursor{scanned}',scanned_sequence=str(scanned),frontier=str(scanned),live=live)
snapshot=dict(snapshot_id='snap1',expires_at='2026-10-07T00:05:00.000Z',workspace_id='w1',room_id='r1',thread_id='t1',watermark='10',frontier='10',cursor='cursor10',policy_revision='1',messages=[msg(10)],members=[dict(account_id='alice',role='owner'),dict(account_id='bob',role='member')],threads=[dict(thread_id='t1',archived=False)],capabilities=['read','send'],read=dict(prefix='0',intervals=[],attention=False),active_runs=[],cards=[])
accepted=dict(status='accepted',client_operation_id=env['client_operation_id'],digest=digest(env),message_id='m1',room_id='r1',thread_id='t1',sequence='1',redacted=False,retry='none')
rejected=dict(status='rejected',client_operation_id=env['client_operation_id'],digest=digest(env),reason='policy_changed',retry='none')
initial=dict(namespace='alice',selected_room_id='r1',selected_thread_id='t1',messages=[],cursor=None,live=False,outbox={},read=dict(prefix='0',intervals=[],attention=False))
cases=[]
def case(id,steps,expected,setup=None): cases.append(dict(id=id,initial=setup or initial,steps=steps,expected=expected))
def step(type,**kw):return dict(type=type,**kw)
case('send-accepted',[step('outbox',state='draft',envelope=env),step('outbox',state='sending',envelope=env),step('operation',result=accepted)],dict(outbox_state='accepted',outbox_envelope=env,message_ids=[]))
case('lost-send-response',[step('outbox',state='sending',envelope=env),step('outbox',state='checking',envelope=env),step('operation',result=accepted)],dict(outbox_state='accepted',outbox_envelope=env))
case('lookup-not-found-keeps-envelope',[step('outbox',state='checking',envelope=env),step('operation',result=dict(status='not_found',client_operation_id=env['client_operation_id'],retry='unchanged_or_seal'))],dict(outbox_state='checking',outbox_envelope=env))
case('recovery-unknown-no-replay',[step('outbox',state='checking',envelope=env),step('operation',result=dict(status='recovery_unknown',client_operation_id=env['client_operation_id'],retry='reconcile_only'))],dict(outbox_state='checking',outbox_envelope=env,recovery_required=True))
case('terminal-rejection-preserves-draft',[step('outbox',state='sending',envelope=env),step('operation',result=rejected)],dict(outbox_state='rejected',outbox_envelope=env))
case('duplicate-events',[step('frame',frame=batch([event(1)],1)),step('frame',frame=batch([event(1)],1))],dict(message_ids=['m1'],cursor='cursor1',live=True))
case('filtered-sequence-gap',[step('frame',frame=batch([event(1),event(5)],5))],dict(message_ids=['m1','m5'],cursor='cursor5',live=True))
case('empty-page-advances',[step('frame',frame=batch([],5))],dict(message_ids=[],cursor='cursor5',live=True))
case('snapshot-catch-up',[step('snapshot',snapshot=snapshot),step('frame',frame=batch([event(11)],11))],dict(message_ids=['m10','m11'],cursor='cursor11',live=True))
case('snapshot-preserves-outbox',[step('outbox',state='checking',envelope=env),step('snapshot',snapshot=snapshot)],dict(message_ids=['m10'],outbox_state='checking',outbox_envelope=env,cursor='cursor10',live=False))
case('late-pre-watermark-event',[step('snapshot',snapshot=snapshot),step('frame',frame=batch([event(9)],10))],dict(message_ids=['m10'],cursor='cursor10'))
case('required-unknown-blocks-atomic-batch',[step('frame',frame=batch([event(1),event(2,'future.required')],2))],dict(message_ids=[],cursor=None,upgrade_required=True))
case('required-unknown-schema',[step('frame',frame=batch([event(1,version=2)],1))],dict(message_ids=[],cursor=None,upgrade_required=True))
case('optional-unknown-advances',[step('frame',frame=batch([event(1,'future.optional',False,2)],1))],dict(message_ids=[],cursor='cursor1',upgrade_required=False))
case('reset-holds-live',[step('frame',frame=batch([event(1)],1)),step('frame',frame=dict(type='reset_required',workspace_id='w1',room_id='r1',reason='overflow'))],dict(message_ids=['m1'],live=False,reset_required=True))
case('other-thread-no-navigation',[step('frame',frame=batch([event(2,thread='t2')],2))],dict(selected_room_id='r1',selected_thread_id='t1',message_ids=[],cursor='cursor2'))
case('read-does-not-bridge-gap',[step('read',coverage=dict(prefix='2',intervals=[['5','5']],attention=False))],dict(read=dict(prefix='2',intervals=[['5','5']],attention=False)))
case('sync-never-marks-read',[step('frame',frame=batch([event(1)],1))],dict(read=dict(prefix='0',intervals=[],attention=False)))
case('account-switch-isolates',[step('outbox',state='sending',envelope=env),step('frame',frame=batch([event(1)],1)),step('account_switch',namespace='bob'),step('operation',namespace='alice',result=accepted)],dict(namespace='bob',message_ids=[],outbox_empty=True,cursor=None,live=False))
changed=json.loads(json.dumps(env));changed['text']+='!'
bad_span=json.loads(json.dumps(env));bad_span['mentions'][0]['start']=7
bad_overlap=json.loads(json.dumps(env));bad_overlap['mentions'].append(dict(kind='human',id='bob',start=10,end=13))
corpus=dict(schema_version=1,digest_vectors=[dict(envelope=env,sha256=digest(env)),dict(envelope=changed,sha256=digest(changed))],schema_cases=[dict(id='exact-text',schema='send',value=env,valid=True),dict(id='surrogate-split',schema='send',value=bad_span,valid=False),dict(id='overlapping-mentions',schema='send',value=bad_overlap,valid=False),dict(id='accepted',schema='lookup',value=accepted,valid=True),dict(id='snapshot',schema='snapshot',value=snapshot,valid=True),dict(id='decimal-sequence',schema='event',value=event(9007199254740993),valid=True)],reducer_cases=cases,identity_error_cases=[dict(id="session-invalid",http=dict(error="session_invalid"),frame=dict(type="error",error="session_invalid")),dict(id="identity-unavailable",http=dict(error="identity_unavailable",retry_after=1),frame=dict(type="error",error="identity_unavailable"))])
(root/'fixtures.json').write_text(json.dumps(corpus,ensure_ascii=False,indent=2)+'\n')
