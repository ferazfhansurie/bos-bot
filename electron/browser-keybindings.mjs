// Shared by the renderer and native guests; ordinary typing is never intercepted.
export function browserCommand(input) {
  const key = String(input.key || '').toLowerCase();
  const shift = Boolean(input.shift ?? input.shiftKey), alt = Boolean(input.alt ?? input.altKey);
  const platform=input.platform||(typeof process!=='undefined'?process.platform:typeof navigator!=='undefined'?navigator.platform:'');
  const mac=/darwin|mac/i.test(platform);
  const meta = Boolean(input.meta ?? input.metaKey), ctrl = Boolean(input.control ?? input.ctrlKey);
  if (ctrl && key === 'tab') return shift ? 'previous-tab' : 'next-tab';
  if(ctrl&&['pageup','pagedown'].includes(key))return key==='pageup'?'previous-tab':'next-tab';
  if(!mac&&alt&&!meta&&!ctrl&&['arrowleft','left','arrowright','right'].includes(key))return key.endsWith('left')?'back':'forward';
  if (!(meta || ctrl)) return null;
  if (alt && ['arrowleft', 'left', 'arrowright', 'right'].includes(key)) return key.endsWith('left') ? 'previous-tab' : 'next-tab';
  if (key === '[') return 'back';
  if (key === ']') return 'forward';
  if (key === '+' || key === '=') return 'zoom-in';
  if (key === '-') return 'zoom-out';
  if (key === '0') return 'zoom-reset';
  if (/^[1-9]$/.test(key)) return `tab-${key}`;
  if ((mac&&alt&&key==='i')||(!mac&&shift&&['i','j'].includes(key))) return 'developer-tools';
  if (alt) return null;
  if (key === 't') return shift ? 'reopen-tab' : 'new-tab';
  if (key === 'w' && !shift) return 'close-tab';
  if (key === 'l' && !shift) return 'address';
  if (key === 'f' && !shift) return 'find';
  if (key === 'r') return shift ? 'hard-reload' : 'reload';
  if (key === 'g') return shift ? 'find-previous' : 'find-next';
  if (key === 'd' && !shift) return 'bookmark';
  if (key==='p'&&!shift) return 'print';
  if ((mac&&key==='y'&&!shift)||(!mac&&key==='h'&&!shift))return 'history';
  if (key === 'j' && (mac?shift:!shift)) return 'downloads';
  return null;
}
