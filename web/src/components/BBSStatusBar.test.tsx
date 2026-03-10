import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BBSStatusBar } from './BBSStatusBar';

describe('BBSStatusBar', () => {
  it('shows the active runtime network when it is known', () => {
    render(<BBSStatusBar activeNetwork="devnet" targetNetwork="https://api.devnet.solana.com" />);

    expect(screen.getByText('AgenC v0.1.0 | Solana Devnet')).toBeTruthy();
  });

  it('shows a pending target when config differs from the active runtime network', () => {
    render(
      <BBSStatusBar
        activeNetwork="devnet"
        targetNetwork="https://api.mainnet-beta.solana.com"
      />,
    );

    expect(
      screen.getByText('AgenC v0.1.0 | Solana Devnet | Mainnet pending restart'),
    ).toBeTruthy();
  });
});
