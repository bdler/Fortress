#!/usr/bin/env node
/**
 * src/Index.html 의 <?!= include('X'); ?> 를 실제 파일 내용으로 (재귀적으로) 치환해
 * 하나로 합친 단독 실행용 HTML 을 만든다. (Apps Script 없이 브라우저에서 바로 로컬 대전 가능)
 *
 *   node tools/build.js                 → dist/fortress.html
 *   node tools/build.js /tmp/my.html    → 원하는 경로로 출력 (병렬 작업/테스트용)
 */
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'src');
const outFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'dist', 'fortress.html');
const inc = (name, depth) => {
  if (depth > 5) throw new Error('include 깊이 초과: ' + name);
  return fs.readFileSync(path.join(src, name + '.html'), 'utf8')
    .replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (_, n) => inc(n, depth + 1));
};
const html = inc('Index', 0);
if (/<\?/.test(html)) throw new Error('치환되지 않은 스크립틀릿이 남아 있습니다.');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log('built ' + path.relative(process.cwd(), outFile) + ' (' + Math.round(html.length / 1024) + ' KB)');
