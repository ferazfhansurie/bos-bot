import { describe, expect, it } from 'vitest';
import { dedupeHomeBots } from './home-routing';

describe('owner and peer roster entries', () => {
  it('keeps the owner history and settings when the phone relay is also present', () => {
    const owner={id:'canonical-bot',homeLink:{id:'alist-home',name:'alist bos',online:true}};
    const relay={id:'rb-link-canonical-bot',remote:{homeId:'alist-home'}};
    expect(dedupeHomeBots([relay,owner])).toEqual([owner]);
  });
  it('keeps a phone relay without a direct owner connection', () => {
    const relay={id:'rb-link-canonical-bot',remote:{homeId:'alist-home'}};
    expect(dedupeHomeBots([relay])).toEqual([relay]);
  });
  it('does not merge different homes or different canonical bots', () => {
    const owner={id:'canonical-bot',homeLink:{id:'alist-home',name:'alist bos',online:true}};
    const other={id:'rb-link-canonical-bot',remote:{homeId:'other-home'}};
    const different={id:'rb-link-other-bot',remote:{homeId:'alist-home'}};
    expect(dedupeHomeBots([owner,other,different])).toEqual([owner,other,different]);
  });
});
