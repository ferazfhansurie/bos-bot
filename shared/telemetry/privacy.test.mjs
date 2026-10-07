import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scrubEvent,scrubTransaction,telemetryOptions} from './privacy.mjs';
test('content, credentials, logs and arbitrary metadata cannot leave the event boundary',()=>{
  const secret='fictional-secret';
  const event={event_id:'id',release:'bos@2.0',user:{email:secret},request:{headers:{authorization:secret},data:secret},
    message:secret,extra:{prompt:secret},breadcrumbs:[{message:secret}],contexts:{device:{name:secret}},
    exception:{values:[{type:'Error',value:secret,stacktrace:{frames:[{filename:'/app/services/cloud/selfhost.ts',lineno:1,vars:{otp:secret},context_line:secret}]}}]}};
  assert.ok(!JSON.stringify(scrubEvent(event)).includes(secret));
  const transaction={...event,transaction:secret,spans:[{span_id:'a',op:'http',description:secret,data:{sql:secret}}]};
  assert.ok(!JSON.stringify(scrubTransaction(transaction)).includes(secret));
  assert.equal(scrubEvent(event).exception.values[0].stacktrace.frames[0].lineno,1);
});
test('telemetry stays disabled without a designated DSN and tracing is bounded',()=>{
  assert.equal(telemetryOptions({},'room').enabled,false);
  assert.equal(telemetryOptions({SENTRY_DSN:'test',SENTRY_TRACES_SAMPLE_RATE:'9'},'room').tracesSampleRate,1);
  assert.equal(telemetryOptions({SENTRY_DSN:'test',SENTRY_TRACES_SAMPLE_RATE:'oops'},'room').tracesSampleRate,0.1);
});
