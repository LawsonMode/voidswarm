// Inline SVG ship silhouettes for the lobby / scoreboard (no asset files).
import type { ShipClassId } from '../../shared/types';

const SHAPES: Record<ShipClassId, string> = {
  // Juggernaut: broad armored wedge with a ram prow
  brute: 'M16 1 L24 9 L30 15 L28 29 L16 24 L4 29 L2 15 L8 9 Z M11 12 L21 12',
  // Arcanist: slim dart with a focusing ring
  tech: 'M16 1 L21 17 L28 29 L16 23 L4 29 L11 17 Z M16 9 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0',
  // Artificer: hex body with tool arms
  engineer: 'M16 3 L25 8 L25 20 L16 25 L7 20 L7 8 Z M7 14 L2 18 L2 26 M25 14 L30 18 L30 26 M16 25 L16 30',
};

export function shipIcon(cls: ShipClassId, color: string, size = 22): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'ship-icon');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', SHAPES[cls] ?? SHAPES.brute);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', color);
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linejoin', 'round');
  p.style.filter = `drop-shadow(0 0 3px ${color})`;
  svg.appendChild(p);
  return svg;
}
