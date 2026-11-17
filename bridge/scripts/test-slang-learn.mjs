// 黑话学习模块新增功能自检：sources 字段、深度研究 prompt、解析。
import assert from 'node:assert/strict';
import {
  normalizeSlangEntry,
  createSlangEntry,
  parseResearchJson,
  buildResearchPrompt,
  buildSlangContext,
  SLANG_STATUS,
} from '../src/slang-learner.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. normalize 保留合法 sources，过滤空串并限长
{
  const e = normalizeSlangEntry({
    content: 'yyds',
    sources: ['https://example.com/a', '', ' https://example.com/b '],
  });
  assert.deepEqual(e.sources, ['https://example.com/a', 'https://example.com/b']);
  ok('normalizeSlangEntry 保留/清洗 sources');
}

// 2. createSlangEntry 支持 sources
{
  const e = createSlangEntry({ content: 'xswl', sources: ['https://example.com'] });
  assert.deepEqual(e.sources, ['https://example.com']);
  ok('createSlangEntry 支持 sources');
}

// 3. parseResearchJson 解析 sources
{
  const out = parseResearchJson('[{"content":"yyds","meaning":"永远的神","sources":["https://a",""]}]');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].sources, ['https://a']);
  ok('parseResearchJson 解析 sources');
}

// 4. buildResearchPrompt 要求深度联网与 sources
{
  const prompt = buildResearchPrompt([{ content: 'yyds', evidence: [{ text: '这波 yyds' }] }]);
  assert.ok(prompt.includes('web_fetch'), 'prompt 应要求 web_fetch 抓正文');
  assert.ok(prompt.includes('"sources"'), 'prompt 应要求输出 sources');
  assert.ok(prompt.includes('深度联网考究'), 'prompt 应强调深度联网考究');
  ok('buildResearchPrompt 深度研究指令');
}

// 5. buildSlangContext 只注入已确认且有含义的词条
{
  const ctx = buildSlangContext([
    { content: 'a', meaning: '甲', status: SLANG_STATUS.CONFIRMED, count: 2 },
    { content: 'b', meaning: '', status: SLANG_STATUS.CONFIRMED, count: 1 },
    { content: 'c', meaning: '丙', status: SLANG_STATUS.CANDIDATE, count: 9 },
  ], 8);
  assert.ok(ctx.includes('a：甲'));
  assert.ok(!ctx.includes('b：'));
  assert.ok(!ctx.includes('c：丙'));
  ok('buildSlangContext 只注入已确认且有含义词条');
}

// 6. 传了语料就只注入「真的出现在这段对话里」的词条；没命中返回空
{
  const entries = [
    { content: '肉鸽', meaning: 'Roguelike', usage: '聊游戏', example: '打肉鸽', status: SLANG_STATUS.CONFIRMED, count: 9 },
    { content: '杂鱼', meaning: '菜鸟', usage: '挑衅', example: '杂鱼杂鱼', status: SLANG_STATUS.CONFIRMED, count: 7 },
    { content: '捏捏', meaning: '揉一下', usage: '撒娇', example: '让我捏捏', status: SLANG_STATUS.CONFIRMED, count: 2 },
  ];
  const hit = buildSlangContext(entries, 8, '有没有人打肉鸽啊\n带带');
  assert.ok(hit.includes('肉鸽'), '命中词应注入');
  assert.ok(!hit.includes('杂鱼'), '没出现在语料里的词不该注入');
  const miss = buildSlangContext(entries, 8, '今天天气不错');
  assert.strictEqual(miss, '', '没命中时应返回空串，省掉整块 token');
  ok('buildSlangContext 按当前语料匹配，未命中不注入');
}

console.log(`\n🎉 黑话学习新增逻辑测试通过（${passed} 项）`);
