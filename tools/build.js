#!/usr/bin/env node
/**
 * src/Index.html 의 <?!= include('X'); ?> 를 실제 파일 내용으로 치환해
 * 하나로 합친 단독 실행용 dist/fortress.html 을 만든다.
 * (Apps Script 없이 브라우저에서 바로 열어 로컬 대전 가능)
 */
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'src');
const out = path.join(__dirname, '..', 'dist');
const html = fs.readFileSync(path.join(src, 'Index.html'), 'utf8')
  .replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (_, name) => fs.readFileSync(path.join(src, name + '.html'), 'utf8'));
if (/<\?/.test(html)) throw new Error('치환되지 않은 스크립틀릿이 남아 있습니다.');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'fortress.html'), html);
console.log('built dist/fortress.html (' + Math.round(html.length / 1024) + ' KB)');
