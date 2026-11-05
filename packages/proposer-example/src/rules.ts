import type { A2UIMessage } from '@genui/adapter-a2ui';
import type { JsonObject } from '@genui/ir';
import type { ProposerRule } from './types';

/** demo 面 id（1.11 demo app 沿用；host 可传自己的 surfaceId） */
export const DEMO_SURFACE_ID = 'restaurant-finder';

const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

/** cards 列子节点上限（DEFAULT_LIMITS.maxChildrenPerNode 64 / maxNodes 2000 内的 demo 安全线） */
const MAX_RESTAURANTS = 20;

/** 恒触发 limits.maxDepth（32）block 的链深（denied 路径测量装置，KAN-010） */
const BLOCKED_CHAIN_DEPTH = 33;

type RawComponent = Record<string, unknown>;

function requireString(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value === '') {
    throw new RangeError(`param "${key}" must be a non-empty string`);
  }
  return value;
}

interface RestaurantParams {
  readonly name: string;
  readonly cuisine: string;
  readonly rating: string;
}

function parseRestaurants(params: JsonObject): RestaurantParams[] {
  const raw = params['restaurants'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RangeError('param "restaurants" must be a non-empty array');
  }
  if (raw.length > MAX_RESTAURANTS) {
    throw new RangeError(`param "restaurants" must have at most ${MAX_RESTAURANTS} entries, got ${raw.length}`);
  }
  const restaurants: RestaurantParams[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new RangeError('each restaurants entry must be an object');
    }
    const record = entry as JsonObject;
    restaurants.push({
      name: requireString(record, 'name'),
      cuisine: requireString(record, 'cuisine'),
      rating: requireString(record, 'rating'),
    });
  }
  return restaurants;
}

/**
 * `create-restaurant-list`：createSurface 建立餐馆列表。
 *
 * 树形（官方 20_restaurant-card 风格）：
 * `root[title, cards, footer]`——`cards` 挂卡片列表，`footer` 是 `show-restaurant-details`
 * 的挂载点（增量规则各改一个挂载点：root 归 chip、footer 归 details，互不覆盖，可任意次序组合）。
 */
function createRestaurantList(surfaceId: string): ProposerRule {
  return {
    id: 'create-restaurant-list',
    description: 'createSurface: restaurant list (root[title, cards, footer], dataModel.restaurants)',
    instantiate: (params: JsonObject): A2UIMessage => {
      const restaurants = parseRestaurants(params);
      const components: RawComponent[] = [
        { id: 'root', component: 'Column', children: ['title', 'cards', 'footer'] },
        { id: 'title', component: 'Text', text: 'Restaurants' },
      ];
      const cardIds: string[] = [];
      for (let i = 0; i < restaurants.length; i++) {
        const restaurant = restaurants[i]!;
        const card = `card_${i}`;
        cardIds.push(card);
        components.push(
          { id: card, component: 'Card', child: `${card}_body` },
          { id: `${card}_body`, component: 'Column', children: [`${card}_name`, `${card}_meta`] },
          { id: `${card}_name`, component: 'Text', text: restaurant.name },
          { id: `${card}_meta`, component: 'Row', children: [`${card}_cuisine`, `${card}_rating`] },
          { id: `${card}_cuisine`, component: 'Text', text: restaurant.cuisine },
          { id: `${card}_rating`, component: 'Text', text: restaurant.rating },
        );
      }
      components.push(
        { id: 'cards', component: 'Column', children: cardIds },
        { id: 'footer', component: 'Column', children: [] },
      );
      return {
        kind: 'createSurface',
        payload: {
          surfaceId,
          catalogId: BASIC_CATALOG_ID,
          components,
          dataModel: { restaurants },
        },
      };
    },
  };
}

/** `add-filter-chip`：updateComponents 在列表顶部插入筛选 chip（仅重定义 root + 新增 2 组件）。 */
function addFilterChip(surfaceId: string): ProposerRule {
  return {
    id: 'add-filter-chip',
    description: 'updateComponents: insert a filter chip above the list (redefines root.children only)',
    instantiate: (params: JsonObject): A2UIMessage => {
      const label = requireString(params, 'label');
      return {
        kind: 'updateComponents',
        payload: {
          surfaceId,
          components: [
            { id: 'root', component: 'Column', children: ['filter_row', 'title', 'cards', 'footer'] },
            { id: 'filter_row', component: 'Row', children: ['filter_chip'] },
            { id: 'filter_chip', component: 'Text', text: label },
          ],
        },
      };
    },
  };
}

/**
 * `show-restaurant-details`：updateComponents 在 footer 挂载餐馆详情卡
 * （不动 root/cards——与 add-filter-chip 正交，可任意次序组合）。
 */
function showRestaurantDetails(surfaceId: string): ProposerRule {
  return {
    id: 'show-restaurant-details',
    description: 'updateComponents: mount a restaurant detail card into the footer slot',
    instantiate: (params: JsonObject): A2UIMessage => {
      const name = requireString(params, 'name');
      const rating = requireString(params, 'rating');
      const distance = requireString(params, 'distance');
      const deliveryTime = requireString(params, 'deliveryTime');
      return {
        kind: 'updateComponents',
        payload: {
          surfaceId,
          components: [
            { id: 'footer', component: 'Column', children: ['details_card'] },
            { id: 'details_card', component: 'Card', child: 'details_body' },
            { id: 'details_body', component: 'Column', children: ['details_name', 'details_meta'] },
            { id: 'details_name', component: 'Text', text: name },
            {
              id: 'details_meta',
              component: 'Row',
              children: ['details_rating', 'details_distance', 'details_delivery'],
            },
            { id: 'details_rating', component: 'Text', text: rating },
            { id: 'details_distance', component: 'Text', text: distance },
            { id: 'details_delivery', component: 'Text', text: deliveryTime },
          ],
        },
      };
    },
  };
}

/**
 * `set-sort-order`：updateDataModel 写 `/sortOrder`——结构不变（diff 全 unchanged）的
 * dataModel 级提案；其回滚只能经 adapter 重放恢复（resync 纪律的测量装置）。
 */
function setSortOrder(surfaceId: string): ProposerRule {
  return {
    id: 'set-sort-order',
    description: 'updateDataModel: set /sortOrder (structural no-op; rollback rides on adapter replay)',
    instantiate: (params: JsonObject): A2UIMessage => {
      const field = requireString(params, 'field');
      return {
        kind: 'updateDataModel',
        payload: { surfaceId, path: '/sortOrder', value: field },
      };
    },
  };
}

/** `blocked-deep-chain`：33 层链恒触发 limits.maxDepth block（denied 路径，KAN-010）。 */
function blockedDeepChain(surfaceId: string): ProposerRule {
  return {
    id: 'blocked-deep-chain',
    description: `updateComponents: ${BLOCKED_CHAIN_DEPTH}-level chain, always blocked by limits.maxDepth`,
    instantiate: (_params: JsonObject): A2UIMessage => {
      const components: RawComponent[] = [
        { id: 'root', component: 'Column', child: 'chain_1' },
      ];
      for (let i = 1; i < BLOCKED_CHAIN_DEPTH; i++) {
        components.push({ id: `chain_${i}`, component: 'Column', child: `chain_${i + 1}` });
      }
      components.push({ id: `chain_${BLOCKED_CHAIN_DEPTH}`, component: 'Column' });
      return { kind: 'updateComponents', payload: { surfaceId, components } };
    },
  };
}

/**
 * demo 规则目录（restaurant-finder 主题，1.11 demo app 的提议源）。
 * 全部确定性：同 surfaceId + 同 params 恒得同一帧。
 */
export function createDemoRules(surfaceId: string = DEMO_SURFACE_ID): ProposerRule[] {
  if (typeof surfaceId !== 'string' || surfaceId === '') {
    throw new RangeError('surfaceId must be a non-empty string');
  }
  return [
    createRestaurantList(surfaceId),
    addFilterChip(surfaceId),
    showRestaurantDetails(surfaceId),
    setSortOrder(surfaceId),
    blockedDeepChain(surfaceId),
  ];
}
