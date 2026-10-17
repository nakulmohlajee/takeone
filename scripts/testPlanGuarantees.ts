/**
 * Plan guarantees: a structuring pass that dropped the script and the looks (as slow / fallback
 * models sometimes do) must still yield the full approved script and every picked look.
 * Run: npx tsx scripts/testPlanGuarantees.ts
 */
import assert from 'node:assert/strict';
import { normalizeProductionPlan, repairPlanAnchors, validateAgainstPrefs } from '../server/script/productionPlan';
import {
  fillMissingLooks,
  planSpokenWordCount,
  restoreSpokenLines,
  spokenParagraphsFromScript,
} from '../server/script/planGuarantees';

const idea =
  'My first sourdough loaf took 36 hours and came out as a dense brick. Funny story of what went wrong and the one lesson I learned about starter timing.';
const creativeScript = `TITLE: The 36-Hour Brick
LOGLINE: A sourdough beginner learns starter timing the hard way.

I spent thirty-six hours nursing my first sourdough loaf like a sick Victorian child, and it baked into a literal weapon.
[VISUAL/EDIT NOTE: Hold the dense loaf up to camera, punch in on "literal weapon".]

Look at this thing. It could stop a home invasion. I did every stretch and fold on time and tucked it into the fridge overnight with total confidence.
[VISUAL/EDIT NOTE: B-roll of dough being stretched and folded in a glass bowl.]

Next morning: zero rise. Here is the mistake nobody warned me about. I used my starter six hours after it peaked, when it had completely deflated.
[VISUAL/EDIT NOTE: Text pop "STARTER WAS DEAD".]

Sourdough isn't on your schedule, you're on its schedule. Catch the starter at its bubbly peak, or you're just making tactical masonry.`;

const prefs = {
  shots: 'few',
  looks: ['talking_head', 'broll', 'overlays', 'text_pops'],
  captions: 'bold_pop',
  cleanup: { silences: true, fillers: true },
  music: true,
} as any;
const opts = { idea, duration: '45 seconds', style: 'Warm & funny vlog', isLongForm: false, aspectRatio: '9:16', prefs };

// 1) Parsing the pass-1 script: 4 spoken paragraphs, notes and header excluded.
const paras = spokenParagraphsFromScript(creativeScript);
assert.equal(paras.length, 4, `paragraphs: ${paras.length}`);
assert.ok(!paras.some((p) => /TITLE|LOGLINE|VISUAL\/EDIT/i.test(p.text)), 'header/notes leaked into speech');
assert.ok(paras[1].note?.includes('stretched and folded'), 'note attached to its paragraph');
const scriptWords = paras.reduce((a, p) => a + p.text.split(/\s+/).length, 0);

// 2) Degenerate structuring output: one line of speech, no inserts (what the fallback returned).
const degenerate = {
  title: 'Sourdough',
  logline: 'x',
  creativeBrief: { contentType: 'talking_head', storyObjective: 'x', captureStrategy: 'multi_take' },
  scenes: [
    { sceneNumber: 1, title: 'Intro', editIntent: 'hook', dialogue: { required: true, teleprompterText: 'I made bread.' }, mediaPlan: { kind: 'none' } },
    { sceneNumber: 2, title: 'Mistake', editIntent: 'explanation', mediaPlan: { kind: 'none' } },
    { sceneNumber: 3, title: 'B-roll', mediaPlan: { kind: 'cutaway', parentBeatRef: '1' } },
  ],
};
let plan = repairPlanAnchors(restoreSpokenLines(normalizeProductionPlan(degenerate, opts), creativeScript));
assert.ok(
  planSpokenWordCount(plan) >= scriptWords * 0.95,
  `speech not restored: ${planSpokenWordCount(plan)} of ${scriptWords} words`
);
const before = validateAgainstPrefs(plan, prefs);
assert.ok(!before.ok, 'degenerate plan should be missing looks');

// 3) Fill the looks deterministically → validation passes, every visual has a prompt and a
//    spoken anchor, every text pop has text.
plan = repairPlanAnchors(fillMissingLooks(plan, prefs, idea));
const after = validateAgainstPrefs(plan, prefs);
assert.ok(after.ok, `still missing: ${after.missing.join(' | ')}`);
const spoken = plan.scenes
  .map((s: any) => s.teleprompterPrompt || '')
  .join(' ')
  .toLowerCase();
for (const s of plan.scenes as any[]) {
  for (const ins of s.recipe?.inserts || []) {
    if (ins.kind === 'text_pop') assert.ok(String(ins.text || '').trim(), 'text pop without text');
    else assert.ok(String(ins.prompt || '').trim().length > 20, `${ins.kind} without a prompt`);
    assert.ok(
      spoken.includes(String(ins.anchorPhrase).toLowerCase()),
      `anchor not spoken verbatim: "${ins.anchorPhrase}"`
    );
  }
  if (s.filmedBy === 'ai') {
    assert.ok(String(s.aiGenerationPrompt || '').trim(), `AI scene "${s.title}" has no prompt`);
    assert.ok(!/I made bread/.test(s.aiGenerationPrompt), 'AI prompt built from the lost line');
    assert.ok(spoken.includes(String(s.mediaTimingHint || '').toLowerCase()), 'AI scene timed to an unspoken line');
  }
}
// No private bookkeeping leaks into the plan.
assert.ok(!(plan.scenes as any[]).some((s) => '_scriptNotes' in s), '_scriptNotes leaked');

// 4) An intact plan is left alone (no duplicate speech, no extra inserts).
const intact = restoreSpokenLines(plan, creativeScript);
assert.equal(planSpokenWordCount(intact), planSpokenWordCount(plan));
const refilled = fillMissingLooks(intact, prefs, idea);
const count = (p: any) => p.scenes.reduce((a: number, s: any) => a + (s.recipe?.inserts?.length || 0), 0);
assert.equal(count(refilled), count(plan), 'fill added inserts to a plan that already had every look');

for (const s of plan.scenes as any[]) {
  console.log(`#${s.sceneNumber} ${s.title} (${s.filmedBy}) — ${String(s.teleprompterPrompt || s.aiGenerationPrompt || '').slice(0, 70)}…`);
  for (const ins of s.recipe?.inserts || []) {
    console.log(`   ${ins.kind}/${ins.layout} @ "${ins.anchorPhrase}" → ${ins.text || String(ins.prompt).slice(0, 80)}`);
  }
}
console.log('\nok — plan guarantees');
