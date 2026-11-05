import type { JsonObject } from '@genui/ir';
import type { ProposerGoal } from '@genui/proposer-example';

/** 餐馆列表参数（确定性：3 家，固定顺序） */
export const RESTAURANT_LIST_PARAMS: JsonObject = {
  restaurants: [
    { name: 'Golden Dragon', cuisine: 'Chinese', rating: '4.6' },
    { name: 'Napoli Pizza', cuisine: 'Italian', rating: '4.4' },
    { name: 'Sushi Kaido', cuisine: 'Japanese', rating: '4.8' },
  ],
};

/** 筛选 chip 参数 */
export const FILTER_CHIP_PARAMS: JsonObject = { label: 'Open now' };

/** 餐馆详情参数（Sushi Kaido） */
export const DETAILS_PARAMS: JsonObject = {
  name: 'Sushi Kaido',
  rating: '4.8',
  distance: '1.2 km',
  deliveryTime: '25-35 min',
};

/** 排序字段参数 */
export const SORT_ORDER_PARAMS: JsonObject = { field: 'rating' };

/** demo 提议目标按钮（goal 确定性：同 goal 恒提议同一帧） */
export interface DemoGoal {
  /** 稳定键（React 列表 key） */
  readonly key: string;
  /** 按钮文案 */
  readonly label: string;
  readonly goal: ProposerGoal;
}

/** 5 个 demo 规则的提议按钮目录（与 createDemoRules 注册序一致） */
export const DEMO_GOALS: readonly DemoGoal[] = [
  {
    key: 'create-restaurant-list',
    label: 'Propose: restaurant list',
    goal: { ruleId: 'create-restaurant-list', params: RESTAURANT_LIST_PARAMS },
  },
  {
    key: 'add-filter-chip',
    label: 'Propose: filter chip',
    goal: { ruleId: 'add-filter-chip', params: FILTER_CHIP_PARAMS },
  },
  {
    key: 'show-restaurant-details',
    label: 'Propose: restaurant details',
    goal: { ruleId: 'show-restaurant-details', params: DETAILS_PARAMS },
  },
  {
    key: 'set-sort-order',
    label: 'Propose: sort order',
    goal: { ruleId: 'set-sort-order', params: SORT_ORDER_PARAMS },
  },
  {
    key: 'blocked-deep-chain',
    label: 'Propose: blocked deep chain',
    goal: { ruleId: 'blocked-deep-chain', params: {} },
  },
];
