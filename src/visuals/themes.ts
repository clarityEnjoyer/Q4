export interface ThemePreset {
  id: string;
  label: string;
  variables: Record<string, string>;
}

export type DensityMode = 'comfortable' | 'compact';

export const THEME_REGISTRY: ThemePreset[] = [
  {
    id: 'boron-dark',
    label: 'Boron Dark',
    variables: {
      '--bg-base': '#0b1120',
      '--bg-card': '#111827',
      '--bg-elevated': '#1e293b',
      '--border-subtle': '#1f2937',
      '--border-focus': '#334155',
      '--text-main': '#f8fafc',
      '--text-muted': '#94a3b8',
      '--text-dim': '#64748b',
    },
  },
  {
    id: 'oled-midnight',
    label: 'OLED Pitch',
    variables: {
      '--bg-base': '#000000',
      '--bg-card': '#090d16',
      '--bg-elevated': '#111827',
      '--border-subtle': '#1e293b',
      '--border-focus': '#334155',
      '--text-main': '#ffffff',
      '--text-muted': '#94a3b8',
      '--text-dim': '#64748b',
    },
  },
  {
    id: 'nord-frost',
    label: 'Nord Frost',
    variables: {
      '--bg-base': '#242933',
      '--bg-card': '#2e3440',
      '--bg-elevated': '#3b4252',
      '--border-subtle': '#434c5e',
      '--border-focus': '#4c566a',
      '--text-main': '#eceff4',
      '--text-muted': '#d8dee9',
      '--text-dim': '#9099ab',
    },
  },
  {
    id: 'warm-paper',
    label: 'Solar Paper',
    variables: {
      '--bg-base': '#f8f5ed',
      '--bg-card': '#ffffff',
      '--bg-elevated': '#eee8d5',
      '--border-subtle': '#e2dac2',
      '--border-focus': '#c9bfa3',
      '--text-main': '#1e293b',
      '--text-muted': '#475569',
      '--text-dim': '#64748b',
    },
  },
];

export function applyVisualTheme(themeId: string, density: DensityMode): void {
  if (typeof document === 'undefined') return;
  const theme = THEME_REGISTRY.find((t) => t.id === themeId) ?? THEME_REGISTRY[0];
  const rootStyle = document.documentElement.style;
  for (const [key, value] of Object.entries(theme.variables)) {
    rootStyle.setProperty(key, value);
  }
  document.documentElement.dataset.density = density;
  document.documentElement.dataset.theme = theme.id;
}
