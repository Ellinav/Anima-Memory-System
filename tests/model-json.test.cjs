const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const root = process.env.ANIMA_SOURCE_ROOT || path.resolve(__dirname,'..');
const read = name => fs.readFileSync(path.join(root,'scripts',name+'.js'),'utf8');
(async()=>{
const utils = await import(pathToFileURL(path.resolve(root,'scripts/utils.js')).href);
const c = vm.createContext({...utils, console:{log(){},warn(){}}});
const summarySource = read('summary_logic');
const start = summarySource.search(/(?:let|const) parsedResult = /);
const end = summarySource.indexOf('if (summaryBatch.length === 0)',start);
assert(start>0&&end>start);
vm.runInContext(`function summaries(rawResult) {
let summaryBatch=[]; const settings={output_regex:[]};
${summarySource.slice(start,end)}
return summaryBatch;
}`,c);
const dictStart = summarySource.indexOf('function extractDictUpdates(rawResult) {');
assert(dictStart>0);
vm.runInContext(summarySource.slice(dictStart),c);
const batchStart = summarySource.indexOf('      let summaryBatch = [];');
const saveStart = summarySource.indexOf('      await handlePostSummary(',batchStart);
assert(batchStart>0&&saveStart>batchStart);
vm.runInContext(`async function saveFlow(raw) {
const calls=[]; const settings={output_regex:[]}; const contextMsgArray=[];
const finalIndex=1,startId=0,targetEndId=9,currentChatId='test-chat';
const requestSummaryFromAPI=async()=>raw;
const autoUpdateDictionary=async rows=>calls.push({kind:'dictionary',rows});
const saveSummaryBatchToWorldbook=async rows=>calls.push({kind:'summary',rows});
try { ${summarySource.slice(batchStart,saveStart)} }
catch(error) { return {calls,error:error.message}; }
return {calls};
}`,c);
const plain = result => JSON.parse(JSON.stringify(result));
const wrap = text => '```json\n'+text+'\n```';
const tags = {vibe:'Angst',special:[],important:true};
const quoteTexts = [
  '她收到一条留言："吃饭了吗？"随后关闭了通讯器。',
  '城市发生"静默"，值班员听到："请保持联络。"随后记录了结果。',
];
const summaryBody = summary => JSON.stringify({summaries:[{summary,tags}]});
for (const [i,text] of quoteTexts.entries()) {
  test(`summary quote failure ${i+1}: preserve full narrative instead of extracting tags`,()=>{
    const raw=wrap(summaryBody(text).replaceAll('\\"','"'));
    const batch=c.summaries(raw);
    assert.equal(batch.length,1);
    assert.equal(batch[0].content,text);
  });
}
const cases = [
 ['valid summary stays intact',()=>assert.equal(c.summaries(wrap(summaryBody(quoteTexts[0])))[0].content,quoteTexts[0])],
 ['status quote repair preserves entire updates object',()=>{
   const raw='{"updates":{"note":"她说："别走"。","nested":{"hp":10}}}';
   assert.deepEqual(plain(c.extractJsonResult(raw)),[{updates:{note:'她说："别走"。',nested:{hp:10}}}]);
 }],
 ['GC rejects incomplete outer object rather than accepting nested update',()=>{
   assert.throws(()=>c.extractJsonResult('{"updates":{"hp":10}'),/JSON.*(不完整|截断|格式)/);
 }],
 ['summary rejects truncated outer object with a complete tags child',()=>{
   assert.throws(()=>c.summaries('{"summaries":[{"summary":"第一段","tags":{"vibe":"Angst"}}, {"summary":"第二'),/JSON.*(不完整|截断|格式)/);
 }],
 ['missing final value is rejected, not synthesized',()=>{
   assert.throws(()=>c.extractJsonResult('{"updates":{"hp":}}'),/JSON.*格式/);
 }],
 ['tag-only JSON produces a schema error',()=>assert.throws(()=>c.summaries('{"vibe":"Angst"}'),/总结.*(字段|结构)/)],
 ['bad summary type is rejected before content.trim',()=>assert.throws(()=>c.summaries('{"summaries":[{"summary":42}]}'),/总结.*(字符串|字段|结构)/)],
 ['dictionary updates can repair quotes without losing index',()=>{
   const raw=wrap('{"summaries":[{"summary":"故事"}],"dict_updates":[{"index":"代号"A"","trigger":"系统"}]}');
   assert.deepEqual(plain(c.extractDictUpdates(raw)),[{index:'代号"A"',trigger:'系统'}]);
 }],
 ['incomplete response must not partially update dictionary',()=>{
   assert.deepEqual(plain(c.extractDictUpdates('{"dict_updates":[{"index":"T","trigger":"AI"}],"summaries":[')),[]);
 }],
 ['valid dictionary names retain brackets and braces',()=>{
   const raw=JSON.stringify({summaries:[{summary:'故事'}],dict_updates:[{index:'站点[北区] {A}',trigger:''}]});
   assert.deepEqual(plain(c.extractDictUpdates(raw)),[{index:'站点[北区] {A}',trigger:''}]);
 }],
 ['existing plain-text summary fallback works',()=>assert.equal(c.summaries('第一天：她醒了。')[0].content,'第一天：她醒了。')],
 ['plain-text summaries retain literal unbalanced brackets',()=>{
   const text='她在便签上写下 [待定，门牌是 {北门}。';
   assert.equal(c.summaries(text)[0].content,text);
 }],
 ['closed reasoning blocks cannot supply or hide the final JSON result',()=>{
   const raw='<thinking>草稿 {"updates":{"hp":1}}，注意未闭合符号 [</thinking>\n{"updates":{"hp":10}}';
   assert.deepEqual(plain(c.extractJsonResult(raw)),[{updates:{hp:10}}]);
 }],
 ['literal reasoning tags inside summary content are preserved',()=>{
   const text='记录中的原文是 <thinking>不要删除这段</thinking>。';
   for (const raw of [summaryBody(text),wrap(summaryBody(text)),
     '<think>先整理</think>\n'+wrap(summaryBody(text))]) {
     assert.equal(c.summaries(raw)[0].content,text);
   }
 }],
 ['ignore prose [status] before real JSON',()=>assert.deepEqual(plain(c.extractJsonResult('I check [status]... {"updates":{"hp":10}} End')),[{updates:{hp:10}}])],
 ['real escaped backslashes and quotes stay intact',()=>{
   const text='路径 C:\\ship\\logs，她说："别走"。';
   assert.equal(c.summaries(summaryBody(text))[0].content,text);
 }],
 ['literal newline inside a JSON string can be escaped without losing content',()=>{
   assert.equal(c.summaries('{"summaries":[{"summary":"第一行\n第二行"}]}')[0].content,'第一行\n第二行');
 }],
 ['data-array wrapper remains compatible',()=>assert.equal(c.summaries('{"data":[{"content":"故事"}]}')[0].content,'故事')],
 ['syntax error reports response length and tail',()=>{
   assert.throws(()=>c.extractJsonResult(wrap('{"summaries":[{"summary":"未闭合')),
    e=>e.message.includes('原文长度')&&e.message.includes('末尾')&&e.message.includes('API返回片段'));
 }],
 ['raw quote repair preserves brackets inside dialogue',()=>{
   const text='她说："打开 {系统} 和 [日志]"。';
   assert.equal(c.summaries(summaryBody(text).replaceAll('\\"','"'))[0].content,text);
 }],
 ['null tags remain optional instead of crashing a valid summary',()=>{
   assert.equal(c.summaries('{"summaries":[{"summary":"故事","tags":null}]}')[0].content,'故事');
 }],
 ['no array element is silently lost if one item is malformed',()=>{
   assert.throws(()=>c.summaries('{"summaries":[{"summary":"完整"},{"tags":{"vibe":"Angst"}}]}'),/总结.*(字段|结构)/);
 }],
 ['missing comma is rejected instead of silently changing structure',()=>{
   assert.throws(()=>c.extractJsonResult('{"updates":{"hp":10 "mp":20}}'),/JSON.*格式/);
 }],
];
for(const [name,fn] of cases)test(name,fn);
test('summary save flow preserves repaired content and rejects malformed schema before any writes',async()=>{
  const raw=wrap(JSON.stringify({summaries:[{summary:quoteTexts[1],tags}],dict_updates:[{index:'控制系统',trigger:'系统'}]}).replaceAll('\\"','"'));
  const success=await c.saveFlow(raw);
  assert.equal(success.error,undefined);
  assert.equal(success.calls.find(call=>call.kind==='summary').rows[0].content,quoteTexts[1]);
  assert.equal(success.calls.find(call=>call.kind==='dictionary').rows[0].index,'控制系统');
  const failed=await c.saveFlow('{"summaries":[{"tags":{"vibe":"Angst"}}],"dict_updates":[{"index":"T"}]}');
  assert.match(failed.error,/总结.*(字段|结构)/);
  assert.equal(failed.calls.length,0);
});
})().catch(e=>{console.error(e);process.exitCode=1;});
