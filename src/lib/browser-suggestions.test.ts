import { describe, expect, it } from 'vitest';
import { browserSuggestions, browserStartSites } from './browser-suggestions';
const page=(url:string,title='Page')=>({id:url,url,title});
describe('navigation suggestions',()=>{
 it('keeps ordinary YouTube pages while excluding sign-in and captcha handoffs',()=>{
  const entries=[page('https://www.youtube.com/watch?v=hello','YouTube video'),page('https://www.google.com/sorry/index?continue=secret','YouTube'),page('https://auth.atlassian.com/authorize?context=secret','YouTube'),page('https://auth.openai.com/api/accounts/callback/google?code=secret','YouTube'),page('https://example.com/path?token=secret','YouTube')];
  expect(browserSuggestions(entries,'you')).toEqual([expect.objectContaining({title:'YouTube video',display:'youtube.com/watch'})]);
 });
 it('deduplicates, bounds results, and never shows raw URL titles with query strings',()=>{
  const entries=Array.from({length:12},(_,n)=>page(`https://example.com/${n}?q=something`,`https://example.com/${n}?q=something`));
  expect(browserSuggestions([...entries,...entries],'example')).toHaveLength(6);
  expect(browserSuggestions(entries,'example')[0].title).toBe('example.com/0');
  expect(browserSuggestions(entries,'')).toHaveLength(0);
 });
 it('uses saved favourites or distinct ordinary recent sites without login redirects',()=>{
  const history=[page('https://accounts.google.com/login'),page('https://www.youtube.com/watch?v=a'),page('https://www.youtube.com/watch?v=b'),page('https://github.com/a')];
  expect(browserStartSites([],history).map(x=>[x.url,x.title])).toEqual([['https://www.youtube.com','YouTube'],['https://github.com','GitHub']]);
  const chosen=page('https://example.com/saved','My saved page'); expect(browserStartSites([chosen],history)).toEqual([chosen]);
 });
});
