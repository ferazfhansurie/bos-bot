import { describe, it, expect } from 'vitest';
import { teachingPrompt } from './teaching-demonstration';
describe('reviewed demonstrations', () => {
 it('retains exact ordered step notes and actual times without claiming execution', () => {
  const text=teachingPrompt('file a receipt',[{id:'a',atMs:1240,note:'open the receipt form'},{id:'b',atMs:2500,note:'choose the account'}]);
  expect(text).toContain('"atSeconds": 1.2');expect(text).toContain('"screenshot": 2');expect(text).toContain('do not execute');expect(text).toContain('normal skill review flow');
 });
 it('requires intent and human notes, bounds size, rejects invalid times',()=>{
  expect(()=>teachingPrompt('',[])).toThrow();expect(()=>teachingPrompt('task',[])).toThrow();
  expect(()=>teachingPrompt('task',[{id:'x',atMs:0,note:''}])).toThrow();
  expect(()=>teachingPrompt('task',[{id:'x',atMs:NaN,note:'step'}])).toThrow();
  expect(()=>teachingPrompt('task',Array.from({length:21},()=>({id:'x',atMs:0,note:'step'})))).toThrow();
 });
});
