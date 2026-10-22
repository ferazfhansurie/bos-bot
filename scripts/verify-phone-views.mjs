// Offline native-view acceptance: slow browser ACKs and idle computer capture.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const bytes = readFileSync(new URL('../ios/App/ImagePreview.png', import.meta.url));
const png = bytes.toString('base64');
const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
let denied = false;
let selected = null;
let acknowledgements = 0, captures = 0;
const viewers = new Set();
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const json = (status, data) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(data)); };
  if (req.headers.authorization !== 'Bearer browser-fixture-token') return json(401, {error:'fixture bearer required'});
  if (path === '/fixture/stats') return json(200, {acknowledgements, captures});
  if (path === '/fixture/deny-preview') { denied = true; return json(200, {ok:true}); }
  if (path.endsWith('/runtime')) return json(200, {
    threadId: new URL(req.url, 'http://localhost').searchParams.get('threadId'),
    selected, busy: false, runtimeLocation: 'server', hostRequired: true, supportsMigration: false,
    options: [{surface:'browser',label:'Browser',available:true,ready:true,canStart:false,canCreate:false},
      {surface:'local',label:'This computer',available:true,ready:true,canStart:false,canCreate:false}]
  });
  if (req.method === 'PATCH' && /\/tasks\/[^/]+$/.test(path)) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.deferComputerStart !== true) return json(400, {error:'selection must not start compute'});
    selected = body.surface; return json(200, {ok:true});
  }
  if (path.endsWith('/computer/preview')) { captures++; return denied
    ? json(403, {error:'Enable computer viewing for this phone in BOS settings.'})
    : json(200, {surface:'vm', png, format:'image/png'}); }
  if (path.endsWith('/browser/live')) {
    res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-store'});
    const viewer = {res, seq:0}; viewers.add(viewer);
    viewer.send = () => { if (!res.destroyed) res.write(`event: frame\ndata: ${JSON.stringify({seq:++viewer.seq,data:png,metadata:{deviceWidth:width,deviceHeight:height}})}\n\n`); };
    res.write('event: ready\ndata: {"viewerId":"fixture-view"}\n\nevent: control\ndata: {"controlling":false,"held":false}\n\n');
    viewer.send();
    res.on('close', () => viewers.delete(viewer)); return;
  }
  if (path.endsWith('/browser/action')) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const action = JSON.parse(Buffer.concat(chunks).toString());
    if (action.type === 'ack') {
      acknowledgements++;
      await new Promise(resolve => setTimeout(resolve, 800));
      json(200, {ok:true}); for (const viewer of viewers) setTimeout(viewer.send, 20); return;
    }
    return json(200, {ok:true});
  }
  return json(404, {error:'no fixture route'});
});
server.listen(Number(process.env.BOS_PHONE_VIEW_FIXTURE_PORT || 0), '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
process.on('SIGINT', () => { server.closeAllConnections(); server.close(); });
