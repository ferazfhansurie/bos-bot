// BOS telemetry never carries conversation, client, auth, OTP or provider data.
// Build an allowlist rather than hoping to find every possible sensitive key.
export function scrubEvent(event) {
  return {
    event_id: event.event_id, timestamp: event.timestamp, platform: event.platform,
    level: event.level, release: event.release, environment: event.environment,
    exception: event.exception && {values:event.exception.values?.map(v=>({
      type: v.type, value: 'BOS runtime error (details withheld)',
      stacktrace: v.stacktrace && {frames:v.stacktrace.frames?.map(f=>({
        filename: f.filename?.replace(/^.*(?=\/(?:services|shared|server|electron)\/)/,''),
        function:f.function, lineno:f.lineno, colno:f.colno, in_app:f.in_app,
      }))},
      mechanism:v.mechanism && {type:v.mechanism.type,handled:v.mechanism.handled},
    }))},
    tags: event.tags && {component:event.tags.component},
  };
}
export function scrubSpan(span) {
  return {span_id:span.span_id,trace_id:span.trace_id,parent_span_id:span.parent_span_id,
    op:span.op,description:'BOS operation',start_timestamp:span.start_timestamp,
    timestamp:span.timestamp,status:span.status};
}
export function scrubTransaction(event) {
  return {...scrubEvent(event),type:'transaction',transaction:'BOS operation',
    start_timestamp:event.start_timestamp,spans:event.spans?.map(scrubSpan),
    contexts:event.contexts?.trace && {trace:scrubSpan(event.contexts.trace)}};
}
export function telemetryOptions(env, component) {
  const rate=Number(env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1');
  return {
    dsn:env.SENTRY_DSN || undefined,enabled:Boolean(env.SENTRY_DSN),
    release:env.SENTRY_RELEASE || 'bos@2.0.0-dev',environment:env.SENTRY_ENVIRONMENT || 'development',
    tracesSampleRate:Number.isFinite(rate)?Math.max(0,Math.min(1,rate)):0.1,
    dataCollection:{userInfo:false,cookies:false,httpHeaders:false,httpBodies:[],
      urlQueryParams:false,graphQL:{document:false,variables:false},genAI:{inputs:false,outputs:false},
      databaseQueryData:false,queues:false,stackFrameVariables:false,frameContextLines:0},
    enableLogs:false,enableMetrics:false,maxBreadcrumbs:0,
    beforeSend:scrubEvent,beforeSendTransaction:scrubTransaction,beforeSendSpan:scrubSpan,
    initialScope:{tags:{component}},
  };
}
