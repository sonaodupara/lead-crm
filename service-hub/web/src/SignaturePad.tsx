import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface SignatureHandle { isEmpty(): boolean; clear(): void; toBlob(): Promise<Blob> }

/** Finger/stylus signature capture on a canvas. */
export const SignaturePad = forwardRef<SignatureHandle>(function SignaturePad(_, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const c = canvas.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio; c.height = c.clientHeight * ratio;
    const g = c.getContext('2d')!;
    g.scale(ratio, ratio); g.lineWidth = 2.2; g.lineCap = 'round'; g.strokeStyle = '#111';
    const pos = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    const down = (e: PointerEvent) => { drawing.current = true; c.setPointerCapture(e.pointerId); g.beginPath(); g.moveTo(...pos(e)); };
    const move = (e: PointerEvent) => { if (!drawing.current) return; g.lineTo(...pos(e)); g.stroke(); dirty.current = true; };
    const up = () => { drawing.current = false; };
    c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    return () => { c.removeEventListener('pointerdown', down); c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up); };
  }, []);

  useImperativeHandle(ref, () => ({
    isEmpty: () => !dirty.current,
    clear: () => { const c = canvas.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); dirty.current = false; },
    toBlob: () => new Promise<Blob>((res, rej) => canvas.current!.toBlob((b) => (b ? res(b) : rej(new Error('Could not read signature'))), 'image/png')),
  }));

  return <canvas ref={canvas} className="sig" aria-label="Customer signature" />;
});
