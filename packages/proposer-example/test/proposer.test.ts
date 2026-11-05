import type { A2UIMessage } from '@genui/adapter-a2ui';
import { describe, expect, it } from 'vitest';
import { createDemoRules, DEMO_SURFACE_ID, RuleProposer } from '../src';
import type { ProposerGoal, ProposerRule } from '../src';

const RESTAURANTS = [
  { name: 'The Italian Kitchen', cuisine: 'Italian', rating: '4.8' },
  { name: 'Golden Dragon', cuisine: 'Chinese', rating: '4.5' },
  { name: 'Blue Ocean Sushi', cuisine: 'Japanese', rating: '4.6' },
];

const CREATE: ProposerGoal = {
  ruleId: 'create-restaurant-list',
  params: { restaurants: RESTAURANTS },
};
const CHIP: ProposerGoal = { ruleId: 'add-filter-chip', params: { label: 'Open now' } };
const DETAILS: ProposerGoal = {
  ruleId: 'show-restaurant-details',
  params: { name: 'Pasta Bar', rating: '4.7', distance: '0.4 mi', deliveryTime: '15-25 min' },
};
const SORT: ProposerGoal = { ruleId: 'set-sort-order', params: { field: 'rating' } };
const BLOCKED: ProposerGoal = { ruleId: 'blocked-deep-chain' };

const DEMO_GOALS: ProposerGoal[] = [CREATE, CHIP, DETAILS, SORT, BLOCKED];

function record(value: A2UIMessage, key: string): unknown {
  return value.payload[key];
}

describe('RuleProposer 注册期校验（fail-loud）', () => {
  it('rules 非数组抛 TypeError', () => {
    expect(() => new RuleProposer('nope' as unknown as readonly ProposerRule[])).toThrow(TypeError);
    expect(() => new RuleProposer(42 as unknown as readonly ProposerRule[])).toThrow(TypeError);
  });

  it('规则非对象抛 TypeError', () => {
    expect(() => new RuleProposer([null as unknown as ProposerRule])).toThrow(TypeError);
    expect(() => new RuleProposer(['x' as unknown as ProposerRule])).toThrow(TypeError);
  });

  it('rule.id 空/非字符串抛 RangeError', () => {
    expect(() => new RuleProposer([{ ...CHIP_RULE(), id: '' }])).toThrow(RangeError);
    expect(() => new RuleProposer([{ ...CHIP_RULE(), id: 7 as unknown as string }])).toThrow(RangeError);
  });

  it('description 非字符串抛 TypeError', () => {
    expect(() => new RuleProposer([{ ...CHIP_RULE(), description: 1 as unknown as string }])).toThrow(TypeError);
  });

  it('instantiate 非函数抛 TypeError', () => {
    expect(() => new RuleProposer([{ ...CHIP_RULE(), instantiate: 'nope' as unknown as ProposerRule['instantiate'] }])).toThrow(TypeError);
  });

  it('重复规则 id 抛 RangeError', () => {
    const rules = createDemoRules();
    expect(() => new RuleProposer([...rules, rules[0]!])).toThrow(/duplicate rule id/u);
  });
});

function CHIP_RULE(): ProposerRule {
  return createDemoRules().find((rule) => rule.id === 'add-filter-chip')!;
}

describe('RuleProposer.propose 校验（fail-loud，不静默降级）', () => {
  const proposer = new RuleProposer(createDemoRules());

  it('goal 非对象抛 TypeError', () => {
    expect(() => proposer.propose(null as unknown as ProposerGoal)).toThrow(TypeError);
    expect(() => proposer.propose('create' as unknown as ProposerGoal)).toThrow(TypeError);
  });

  it('ruleId 空/非字符串抛 RangeError', () => {
    expect(() => proposer.propose({ ruleId: '' })).toThrow(RangeError);
    expect(() => proposer.propose({ ruleId: 1 as unknown as string })).toThrow(RangeError);
    expect(() => proposer.propose({} as ProposerGoal)).toThrow(RangeError);
  });

  it('params 非对象抛 RangeError', () => {
    expect(() => proposer.propose({ ruleId: 'add-filter-chip', params: 'x' as unknown as ProposerGoal['params'] })).toThrow(RangeError);
    expect(() => proposer.propose({ ruleId: 'add-filter-chip', params: [1] as unknown as ProposerGoal['params'] })).toThrow(RangeError);
  });

  it('未知规则抛 RangeError', () => {
    expect(() => proposer.propose({ ruleId: 'no-such-rule' })).toThrow(/unknown rule/u);
  });

  it('getRuleIds 按注册序；has 查询', () => {
    expect(proposer.getRuleIds()).toEqual([
      'create-restaurant-list',
      'add-filter-chip',
      'show-restaurant-details',
      'set-sort-order',
      'blocked-deep-chain',
    ]);
    expect(proposer.has('set-sort-order')).toBe(true);
    expect(proposer.has('no-such-rule')).toBe(false);
  });
});

describe('demo 规则目录', () => {
  const proposer = new RuleProposer(createDemoRules());

  it('createDemoRules 空 surfaceId 抛 RangeError', () => {
    expect(() => createDemoRules('')).toThrow(RangeError);
  });

  it('create-restaurant-list：root[title, cards, footer] + dataModel.restaurants', () => {
    const frame = proposer.propose(CREATE);
    expect(frame.kind).toBe('createSurface');
    expect(record(frame, 'surfaceId')).toBe(DEMO_SURFACE_ID);
    const components = record(frame, 'components') as Array<Record<string, unknown>>;
    const root = components.find((entry) => entry['id'] === 'root')!;
    expect(root['children']).toEqual(['title', 'cards', 'footer']);
    const cards = components.find((entry) => entry['id'] === 'cards')!;
    expect((cards['children'] as string[]).length).toBe(3);
    expect(components.find((entry) => entry['id'] === 'card_0_name')!['text']).toBe(RESTAURANTS[0]!.name);
    expect(record(frame, 'dataModel')).toEqual({ restaurants: RESTAURANTS });
  });

  it('create-restaurant-list：params 校验（空数组/超上限/坏条目/缺字段）', () => {
    const bad: ProposerGoal[] = [
      { ruleId: 'create-restaurant-list', params: {} },
      { ruleId: 'create-restaurant-list', params: { restaurants: [] } },
      { ruleId: 'create-restaurant-list', params: { restaurants: 'x' } },
      { ruleId: 'create-restaurant-list', params: { restaurants: [{ name: 'A' }] } },
      { ruleId: 'create-restaurant-list', params: { restaurants: [{ name: 'A', cuisine: 'B' }] } },
      { ruleId: 'create-restaurant-list', params: { restaurants: [{ name: 'A', cuisine: 'B', rating: '' }] } },
    ];
    for (const goal of bad) {
      expect(() => proposer.propose(goal), JSON.stringify(goal.params)).toThrow(RangeError);
    }
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `R${i}`, cuisine: 'C', rating: '4.0' }));
    expect(() => proposer.propose({ ruleId: 'create-restaurant-list', params: { restaurants: many } })).toThrow(/at most 20/u);
  });

  it('add-filter-chip：重定义 root + filter_row/filter_chip；label 校验', () => {
    const frame = proposer.propose(CHIP);
    expect(frame.kind).toBe('updateComponents');
    const components = record(frame, 'components') as Array<Record<string, unknown>>;
    expect(components.find((entry) => entry['id'] === 'root')!['children']).toEqual([
      'filter_row',
      'title',
      'cards',
      'footer',
    ]);
    expect(components.find((entry) => entry['id'] === 'filter_chip')!['text']).toBe('Open now');
    expect(() => proposer.propose({ ruleId: 'add-filter-chip', params: {} })).toThrow(RangeError);
    expect(() => proposer.propose({ ruleId: 'add-filter-chip', params: { label: '' } })).toThrow(RangeError);
  });

  it('show-restaurant-details：footer 挂载 details 卡；字段校验', () => {
    const frame = proposer.propose(DETAILS);
    expect(frame.kind).toBe('updateComponents');
    const components = record(frame, 'components') as Array<Record<string, unknown>>;
    expect(components.find((entry) => entry['id'] === 'footer')!['children']).toEqual(['details_card']);
    expect(components.find((entry) => entry['id'] === 'details_name')!['text']).toBe('Pasta Bar');
    for (const key of ['name', 'rating', 'distance', 'deliveryTime']) {
      const params: Record<string, string> = { name: 'A', rating: '4.0', distance: '1 mi', deliveryTime: '10 min' };
      delete params[key];
      expect(() => proposer.propose({ ruleId: 'show-restaurant-details', params })).toThrow(RangeError);
    }
  });

  it('set-sort-order：updateDataModel /sortOrder；field 校验', () => {
    const frame = proposer.propose(SORT);
    expect(frame.kind).toBe('updateDataModel');
    expect(record(frame, 'path')).toBe('/sortOrder');
    expect(record(frame, 'value')).toBe('rating');
    expect(() => proposer.propose({ ruleId: 'set-sort-order', params: {} })).toThrow(RangeError);
  });

  it('blocked-deep-chain：33 层链恒超 DEFAULT_LIMITS.maxDepth（32）', () => {
    const frame = proposer.propose(BLOCKED);
    expect(frame.kind).toBe('updateComponents');
    const components = record(frame, 'components') as Array<Record<string, unknown>>;
    expect(components.length).toBe(34); // root + chain_1..chain_33
    expect(components.find((entry) => entry['id'] === 'chain_33')).toBeDefined();
  });

  it('自定义 surfaceId 透传到每条规则', () => {
    const custom = new RuleProposer(createDemoRules('my-surface'));
    expect(record(custom.propose(CREATE), 'surfaceId')).toBe('my-surface');
    expect(record(custom.propose(CHIP), 'surfaceId')).toBe('my-surface');
    expect(record(custom.propose(SORT), 'surfaceId')).toBe('my-surface');
  });
});

describe('确定性（无时钟无随机）', () => {
  it('同 params 恒得同一帧：跨实例 ×100', () => {
    const a = new RuleProposer(createDemoRules());
    const b = new RuleProposer(createDemoRules());
    for (let i = 0; i < 100; i++) {
      for (const goal of DEMO_GOALS) {
        expect(a.propose(goal)).toEqual(b.propose(goal));
      }
    }
  });
});
