import { createRoot } from 'react-dom/client';
import { ClosedLoop, createDemoRules, DEMO_SURFACE_ID } from '@genui/proposer-example';
import { StrictMode } from 'react';
import { LoopBridge } from './bridge';
import { DemoApp } from './DemoApp';

const loop = new ClosedLoop({ rules: createDemoRules(), surfaceId: DEMO_SURFACE_ID });
const bridge = new LoopBridge(loop);

const container = document.getElementById('root');
if (container === null) {
  throw new Error('demo app requires a #root container');
}

createRoot(container).render(
  <StrictMode>
    <DemoApp bridge={bridge} />
  </StrictMode>,
);
