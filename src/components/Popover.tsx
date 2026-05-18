'use client';

import React, {
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export type Placement =
  | 'bottom-start'
  | 'bottom-end'
  | 'bottom-auto'
  | 'top-start'
  | 'top-end'
  | 'top-auto';

export interface PopoverCoords {
  top: number;
  left: number;
  width: number | null;
  maxHeight: number;
  /** True when the popover was placed on the side opposite the requested
   *  `placement` because the requested side lacked space. */
  flipped: boolean;
  transformOrigin: 'top' | 'bottom';
}

export interface UsePopoverPositionOpts {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** Ref to the rendered popover element. When provided, its measured size
   *  is used after the first paint so the flip decision and viewport
   *  clamping are based on the actual layout instead of the preferred
   *  estimates. */
  menuRef?: RefObject<HTMLElement | null>;
  placement?: Placement;
  /** Disable vertical flip. Default true. */
  autoFlip?: boolean;
  /** Pins the popover to this width. Takes precedence over `minWidth`. */
  width?: number;
  /** Floor the popover width to `max(anchor.width, minWidth)`. */
  minWidth?: number;
  /** Width estimate used for positioning math when the popover is
   *  CSS-sized (neither `width` nor `minWidth` provided). Avoids a
   *  first-frame snap by giving the hook a sensible value to clamp
   *  against before `menuRef` has been measured. */
  widthEstimate?: number;
  /** Target maximum height — clamped to available viewport space. */
  preferredMaxHeight?: number;
  /** Gap (px) between trigger and popover. */
  offset?: number;
  /** Minimum margin (px) to the viewport edges. */
  viewportPadding?: number;
}

function splitPlacement(p: Placement): ['top' | 'bottom', 'start' | 'end' | 'auto'] {
  const [v, s] = p.split('-') as ['top' | 'bottom', 'start' | 'end' | 'auto'];
  return [v, s];
}

/** Compute viewport-aware coordinates for a popover anchored to a trigger
 *  element. Re-runs on scroll and resize while `open` is true. */
export function usePopoverPosition({
  open,
  anchorRef,
  menuRef,
  placement = 'bottom-start',
  autoFlip = true,
  width: fixedWidth,
  minWidth,
  widthEstimate,
  preferredMaxHeight = 360,
  offset = 4,
  viewportPadding = 8,
}: UsePopoverPositionOpts): PopoverCoords | null {
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const compute = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = viewportPadding;

    let width: number | null = null;
    if (typeof fixedWidth === 'number') {
      width = fixedWidth;
    } else if (typeof minWidth === 'number') {
      width = Math.max(r.width, minWidth);
    }

    const [vert, side] = splitPlacement(placement);
    const horizSide: 'start' | 'end' =
      side === 'auto'
        ? (r.left + r.right) / 2 < vw / 2
          ? 'start'
          : 'end'
        : side;

    const renderedWidth =
      width ?? menuRef?.current?.offsetWidth ?? widthEstimate ?? r.width;
    let left = horizSide === 'end' ? r.right - renderedWidth : r.left;
    if (left + renderedWidth > vw - pad) left = Math.max(pad, vw - renderedWidth - pad);
    if (left < pad) left = pad;

    const measuredHeight = menuRef?.current?.offsetHeight;
    const naturalHeight = Math.min(preferredMaxHeight, measuredHeight ?? preferredMaxHeight);
    const spaceBelow = vh - r.bottom - pad;
    const spaceAbove = r.top - pad;

    // `placeBelow` is the final side the popover lands on, after considering
    // both the requested placement and any auto-flip. `flipped` is reported
    // separately so callers can tell whether the result differs from request.
    let placeBelow: boolean;
    if (!autoFlip) {
      placeBelow = vert === 'bottom';
    } else if (vert === 'bottom') {
      const flip = spaceBelow < naturalHeight && spaceAbove > spaceBelow;
      placeBelow = !flip;
    } else {
      const flip = spaceAbove < naturalHeight && spaceBelow > spaceAbove;
      placeBelow = flip;
    }
    const flipped = placeBelow !== (vert === 'bottom');

    let top: number;
    let maxHeight: number;
    if (placeBelow) {
      top = r.bottom + offset;
      maxHeight = Math.min(preferredMaxHeight, Math.max(0, spaceBelow));
    } else {
      maxHeight = Math.min(preferredMaxHeight, Math.max(0, spaceAbove));
      top = r.top - offset - maxHeight;
    }

    setCoords({
      top,
      left,
      width,
      maxHeight,
      flipped,
      transformOrigin: placeBelow ? 'top' : 'bottom',
    });
  }, [
    anchorRef,
    menuRef,
    placement,
    autoFlip,
    fixedWidth,
    minWidth,
    widthEstimate,
    preferredMaxHeight,
    offset,
    viewportPadding,
  ]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    compute();
    // Re-measure after the menu has rendered so flip/clamp logic uses the
    // popover's true size rather than the preferred estimates.
    const raf = requestAnimationFrame(compute);
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open, compute]);

  return coords;
}

export interface PopoverProps
  extends Omit<UsePopoverPositionOpts, 'open' | 'menuRef'> {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** ARIA role; defaults to `dialog`. Pass `listbox`, `menu`, etc. when appropriate. */
  role?: string;
  /** Inline style overrides merged onto the panel. */
  style?: React.CSSProperties;
  /** Stacking layer. Defaults to 9500 — above app chrome, below toasts. */
  zIndex?: number;
  /** Skip the default chrome and just position + portal the children. */
  bare?: boolean;
}

/** Portaled, viewport-aware popover. Renders nothing until `open`. Dismisses
 *  on outside click and Escape. */
export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  role = 'dialog',
  style,
  zIndex = 9500,
  bare = false,
  ...positionOpts
}: PopoverProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const coords = usePopoverPosition({ open, anchorRef, menuRef, ...positionOpts });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open, onClose, anchorRef]);

  if (!mounted || !open || !coords) return null;

  const baseStyle: React.CSSProperties = {
    position: 'fixed',
    top: coords.top,
    left: coords.left,
    width: coords.width ?? undefined,
    maxHeight: coords.maxHeight,
    zIndex,
    transformOrigin: coords.transformOrigin,
  };
  const chromeStyle: React.CSSProperties = bare
    ? baseStyle
    : {
        ...baseStyle,
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border-default)',
        borderRadius: 6,
        boxShadow: 'var(--shadow-overlay)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'inherit',
        color: 'var(--fg-default)',
      };

  return createPortal(
    <div ref={menuRef} role={role} style={{ ...chromeStyle, ...style }}>
      {children}
    </div>,
    document.body,
  );
}
