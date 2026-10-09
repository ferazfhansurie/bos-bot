#!/usr/bin/env python3
"""Apply the reviewed branding table to tracked files; run again on the batch tip.

No installs, commits, process restarts, downloads or user-data migrations.
Use --check after applying. All frozen spellings and their reasons live in
one JSON compatibility table. Native projects are generated separately.
"""
import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent
TABLE = 'electron/branding-compat.json'
SELF = 'scripts/rename-bos.py'
CFG = json.loads((ROOT / TABLE).read_text())


def selected(path, patterns):
    return any(fnmatch.fnmatchcase(path, p) for p in patterns)


def transform(text, path):
    protected = []
    marker = "__BOS_BRANDING_HELD_"
    while marker in text: marker += "_"
    def hold(match):
        protected.append(match.group())
        return marker + str(len(protected) - 1) + marker
    for row in CFG['rules']:
        if selected(path, row['files']):
            text = re.sub(row['pattern'], hold, text)
    # Frozen iOS install ids, group entitlements and ordinary non-brand keys
    # are untouched by the literal replacements below.
    for old, new in CFG['replacements']:
        text = text.replace(old, new)
    text = re.sub(re.escape(marker) + r'(\d+)' + re.escape(marker), lambda m: protected[int(m[1])], text)
    dest = path
    for old, new in CFG['replacements']:
        dest = dest.replace(old, new)
    for patch in CFG.get('patches', []):
        if patch['path'] == dest and patch['to'] not in text:
            text = text.replace(patch['from'], patch['to'])
    for item in CFG.get('imports', []):
        if item['path'] == dest and item['line'] not in text:
            text = item['line'] + '\n' + text
    return annotate(text, dest)


def annotate(text, path):
    suffix = Path(path).suffix
    if path == '__filename__' or not re.search(CFG['legacyPattern'], text): return text
    rows = [r for r in CFG['rules'] if selected(path, r['files']) and re.search(r['pattern'], text)]
    if not rows: return text
    note = 'branding compatibility (' + TABLE + '): ' + '; '.join(r['id'] + ': ' + r['why'] for r in rows)
    # JSON payload fixtures keep their exact bytes; the table records their reason.
    if suffix in ('.ts', '.tsx', '.mjs', '.cjs', '.swift', '.kt', '.kts', '.jsonc'):
        comment = '// ' + note
    elif suffix in ('.py', '.sh', '.yml', '.yaml', '.toml', '.apparmor'):
        comment = '# ' + note
    elif suffix in ('.md', '.mdx', '.xml', '.plist', '.entitlements', '.html'):
        comment = '<!-- ' + note + ' -->'
    else: return text
    # Remove the previous generated note, so adding a row also stays idempotent.
    lines = [line for line in text.splitlines(keepends=True) if 'branding compatibility (' + TABLE + '): ' not in line]
    return ''.join(lines).rstrip('\n') + '\n' + comment + '\n'


def allowed(text, path):
    if selected(path, CFG['attributionFiles']) or path == TABLE: return []
    for row in CFG['rules']:
        if selected(path, row['files']): text = re.sub(row['pattern'], '', text)
    return [i for i, line in enumerate(text.splitlines(), 1)
            if re.search(CFG['legacyPattern'], line)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if not args.check:
        for old, new in CFG.get('directoryRenames', []):
            if (ROOT / old).is_dir() and not (ROOT / new).exists():
                (ROOT / new).parent.mkdir(parents=True, exist_ok=True)
                subprocess.run(['git', 'mv', old, new], cwd=ROOT, check=True)
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    changes, errors = [], []
    for path in filter(None, files):
        if path in (TABLE, SELF, 'scripts/rename-env.mjs') or selected(path, CFG['attributionFiles']): continue
        file = ROOT / path
        if not file.is_file(): continue
        try: before = file.read_text()
        except UnicodeError: continue
        if os.environ.get("BOS_RENAME_TRACE"): print(path, flush=True)
        after = transform(before, path)
        dest = transform(path, '__filename__')
        if args.check:
            if after != before or dest != path: errors.append(path + ': unapplied branding')
            for line in allowed(before, path): errors.append(f'{path}:{line}: unlisted legacy name')
            continue
        if after != before:
            file.write_text(after)
            changes.append(path)
        if dest != path:
            (ROOT / dest).parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(['git', 'mv', path, dest], cwd=ROOT, check=True)
            changes.append(path + ' -> ' + dest)
    env_result = subprocess.run(['node', str(ROOT / 'scripts/rename-env.mjs')] + (['--check'] if args.check else []), cwd=ROOT)
    if env_result.returncode: errors.append('environment alias transform failed')
    for patch in CFG.get('postEnvPatches', []):
        file = ROOT / patch['path']
        before = file.read_text()
        after = before
        if patch['to'] not in before or patch['to'] in ('env.', 'env.OMB_UPDATE_PROD_BRANCH'):
            after = before.replace(patch['from'], patch['to'])
        if after != before:
            if args.check: errors.append(patch['path'] + ': pending post-env compatibility edit')
            else: file.write_text(after)
    if args.check:
        print('\n'.join(errors) if errors else 'branding applied; every remaining legacy hit is covered by the compatibility table')
        return bool(errors)
    print(f'branding applied to {len(changes)} tracked files/moves; regenerate the iOS project with xcodegen')
    return False

if __name__ == '__main__':
    raise SystemExit(main())
