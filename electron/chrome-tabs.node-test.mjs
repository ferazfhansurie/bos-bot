import {test} from 'node:test';import assert from 'node:assert/strict';import {parseChromeTabs} from './chrome-tabs.mjs';
const int=n=>{const b=Buffer.alloc(4);b.writeInt32LE(n);return b;};
const str=(s,wide=false)=>{const b=Buffer.from(s,wide?'utf16le':'utf8');return Buffer.concat([int(wide?s.length:b.length),b,Buffer.alloc((4-b.length%4)%4)]);};
const command=(id,data)=>{const n=Buffer.alloc(2);n.writeUInt16LE(data.length+1);return Buffer.concat([n,Buffer.from([id]),data]);};
const nav=(tab,index,url,title)=>{const data=Buffer.concat([int(tab),int(index),str(url),str(title,true)]);return command(6,Buffer.concat([int(data.length),data]));};
const header=Buffer.concat([Buffer.from('SNSS'),int(1)]);
test('session parser restores only open tabs with selected navigation, order and pinned status',()=>{
 const data=Buffer.concat([header,command(0,Buffer.concat([int(1),int(2)])),command(2,Buffer.concat([int(1),int(0)])),nav(1,0,'https://example.com/old','Old'),nav(1,1,'https://example.com/new','New'),command(7,Buffer.concat([int(1),int(0)])),command(12,Buffer.concat([int(1),Buffer.from([1,0,0,0])])),nav(3,0,'https://closed.com','Closed'),command(16,int(3))]);
 assert.deepEqual(parseChromeTabs(data),[{url:'https://example.com/old',title:'Old',pinned:true}]);
});
test('truncated, unsupported or pruned sessions fail closed rather than guessing tabs',()=>{
 assert.throws(()=>parseChromeTabs(Buffer.from('secret')));assert.throws(()=>parseChromeTabs(Buffer.concat([header,Buffer.from([50,0,6])])));assert.throws(()=>parseChromeTabs(Buffer.concat([header,command(24,Buffer.alloc(12))])));
});
