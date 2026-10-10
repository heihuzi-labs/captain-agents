import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WorkerIdentity, workerMeta } from '../../app/renderer/ui/index.ts';
import { NetworkNote } from '../../app/renderer/components/Detail.tsx';
import { fixtureJob, fixtureView } from './fixtures.tsx';

afterEach(() => cleanup());

test('能联网的活有“联网”小标签，悬停写“能联网”；关着的活没有', () => {
  const workers = fixtureView().workers, online = fixtureJob('a', { network: true });
  const { unmount } = render(<WorkerIdentity workers={workers} job={online} />);
  expect(screen.getByText('联网').getAttribute('title')).toBe('能联网');
  unmount();
  render(<WorkerIdentity workers={workers} job={fixtureJob('c')} />);
  expect(screen.queryByText('联网')).toBeNull();
  render(<WorkerIdentity workers={workers} job={online} detail="model" />);
  expect(screen.queryByText('联网')).toBeNull();
  expect(workerMeta('M', 'high', null, 'setting', false, true)).toBe('M · 高档 · 联网');
});

test('详情联网一节只写派出时允许联网', () => {
  const { container } = render(<NetworkNote />);
  expect(screen.getByText('联网')).toBeTruthy();
  expect(container.querySelectorAll('p')).toHaveLength(1);
  expect(screen.getByText('这件活派出时允许联网')).toBeTruthy();
});
