// Authored by Tomás Neto (TN 2026)
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KonamiEasterEgg } from './konami';

const press = (...keys: string[]) => keys.forEach((key) => fireEvent.keyDown(window, { key }));
const CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

describe('Konami easter egg', () => {
  it('opens the credits after the full sequence', async () => {
    render(<KonamiEasterEgg />);
    expect(screen.queryByText('Developed by Tomás Neto')).toBeNull();
    press(...CODE);
    expect(await screen.findByText('Developed by Tomás Neto')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /github\.com\/Tomasneto404/ })).toHaveAttribute('href', 'https://github.com/Tomasneto404');
    expect(screen.getByRole('img', { name: 'Flag of Portugal' })).toBeInTheDocument();
  });

  it('ignores a broken sequence and keys typed into inputs', () => {
    render(
      <>
        <input aria-label="field" />
        <KonamiEasterEgg />
      </>,
    );
    press(...CODE.slice(0, 5), 'x', ...CODE.slice(5));
    expect(screen.queryByText('Developed by Tomás Neto')).toBeNull();
    const field = screen.getByLabelText('field');
    CODE.forEach((key) => fireEvent.keyDown(field, { key }));
    expect(screen.queryByText('Developed by Tomás Neto')).toBeNull();
  });
});
