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
  /** Expected popover height used by the flip decision before the menu has
   *  been measured. Lets callers that know their content height (e.g. row
   *  count × row height) avoid a first-frame flip when the trigger sits in
   *  the lower half of the viewport. Falls back to `preferredMaxHeight`. */
  heightEstimate?: number;
  /** Gap (px) between trigger and popover. */
  offset?: number;
  /** Minimum margin (px) to the viewport edges. */
  viewportPadding?: number;
}

/** Compute viewport-aware coordinates for a popover anchored to a trigger
 *  element. Re-runs on scroll and resize while `open` is true. */
export function usePopoverPosition({
  open,
  anchorRef,
  menuRef,
  placement = 'bottom-start',
  width: fixedWidth,
  minWidth,
  widthEstimate,
  preferredMaxHeight = 360,
  heightEstimate,
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

    const [vert, side] = placement.split('-') as ['top' | 'bottom', 'start' | 'end' | 'auto'];
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

    const naturalHeight = Math.min(
      preferredMaxHeight,
      menuRef?.current?.offsetHeight ?? heightEstimate ?? Infinity,
    );
    const spaceBelow = vh - r.bottom - pad;
    const spaceAbove = r.top - pad;
    const requestedBelow = vert === 'bottom';
    const requestedSpace = requestedBelow ? spaceBelow : spaceAbove;
    const otherSpace = requestedBelow ? spaceAbove : spaceBelow;
    // Flip only when the requested side is too small AND the other side is roomier.
    const flipped = requestedSpace < naturalHeight && otherSpace > requestedSpace;
    const placeBelow = flipped ? !requestedBelow : requestedBelow;

    const maxHeight = Math.min(preferredMaxHeight, Math.max(0, placeBelow ? spaceBelow : spaceAbove));
    const top = placeBelow ? r.bottom + offset : r.top - offset - maxHeight;

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
    fixedWidth,
    minWidth,
    widthEstimate,
    preferredMaxHeight,
    heightEstimate,
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

  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    top: coords.top,
    left: coords.left,
    width: coords.width ?? undefined,
    maxHeight: coords.maxHeight,
    zIndex,
    transformOrigin: coords.transformOrigin,
    background: 'var(--bg-subtle)',
    border: '1px solid var(--border-default)',
    borderRadius: 6,
    boxShadow: 'var(--shadow-overlay)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'inherit',
    color: 'var(--fg-default)',
    ...style,
  };

  return createPortal(
    <div ref={menuRef} role={role} style={panelStyle}>
      {children}
    </div>,
    document.body,
  );
}
