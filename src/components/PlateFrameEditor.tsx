import { useRef, useState, useCallback, useEffect } from 'react';
import { Check, RotateCcw, Move } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Constantes compartilhadas — galeria, câmera manual e scanner em tempo real
export const PLATE_FRAME_VW = 78;
export const PLATE_FRAME_MAX_PX = 320;
export const PLATE_EXPORT_SIZE = 640;

// Constantes para Adesivo (Quadrado 1:1)
const STICKER_FRAME_VW = 78;
const STICKER_FRAME_MAX_PX = 320;
const STICKER_EXPORT_SIZE = 640;

interface PlateFrameEditorProps {
  imageUrl: string;
  overlayType: 'plate' | 'number';
  onConfirm: (blob: Blob, dataUrl: string) => void;
  onCancel: () => void;
}

export function PlateFrameEditor({ imageUrl, overlayType, onConfirm, onCancel }: PlateFrameEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const scaleRef = useRef(1);
  const lastPinchRef = useRef<{ dist: number; scale: number } | null>(null);

  const [scale, setScale] = useState(1);
  const [translateX, setTranslateX] = useState(0);
  const [translateY, setTranslateY] = useState(0);

  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [lastPointer, setLastPointer] = useState({ x: 0, y: 0 });

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    if (img.complete && img.naturalWidth) {
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
      return;
    }
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, [imageUrl]);

  const getContainerRect = useCallback(() => {
    return containerRef.current?.getBoundingClientRect() ?? { width: 300, height: 400, left: 0, top: 0 };
  }, []);

  const getFrameSize = useCallback(() => {
    const rect = getContainerRect();
    if (overlayType === 'number') {
      const side = Math.min(rect.width * (STICKER_FRAME_VW / 100), STICKER_FRAME_MAX_PX);
      return { w: side, h: side, left: (rect.width - side) / 2, top: (rect.height - side) / 2 };
    } else {
      const w = Math.min(rect.width * (PLATE_FRAME_VW / 100), PLATE_FRAME_MAX_PX);
      const h = w;
      return { w, h, left: (rect.width - w) / 2, top: (rect.height - h) / 2 };
    }
  }, [getContainerRect, overlayType]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setIsDragging(true);
    setLastPointer({ x: e.clientX, y: e.clientY });
    lastPinchRef.current = null;
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    lastPinchRef.current = null;
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    setTranslateX((t) => t + dx);
    setTranslateY((t) => t + dy);
    setLastPointer({ x: e.clientX, y: e.clientY });
  }, [isDragging, lastPointer]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setIsDragging(false);
    lastPinchRef.current = null;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length >= 2) {
      // PERFEITO: Usando preventDefault sem ser passive
      if (e.cancelable) e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const prev = lastPinchRef.current;
      if (prev !== null) {
        const scaleFactor = dist / prev.dist;
        const newScale = Math.max(0.3, Math.min(5, prev.scale * scaleFactor));
        setScale(newScale);
        lastPinchRef.current = { dist, scale: newScale };
      }
    } else {
      lastPinchRef.current = null;
    }
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length >= 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      lastPinchRef.current = { dist, scale: scaleRef.current };
    } else {
      lastPinchRef.current = null;
    }
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newScale = Math.max(0.3, Math.min(5, scale + delta));
    setScale(newScale);
  }, [scale]);

  const exportCrop = useCallback(() => {
    const rect = getContainerRect();
    const { w: frameW, h: frameH, left: frameLeft, top: frameTop } = getFrameSize();
    const nw = imgSize.w;
    const nh = imgSize.h;
    if (nw === 0 || nh === 0) return;

    const W = rect.width;
    const H = rect.height;
    const centerX = W / 2;
    const centerY = H / 2;

    const frameCorners = [
      [frameLeft, frameTop],
      [frameLeft + frameW, frameTop],
      [frameLeft, frameTop + frameH],
      [frameLeft + frameW, frameTop + frameH],
    ] as const;

    const toImageCoords = (px: number, py: number) => {
      const imX = (px - centerX - translateX) / scale + nw / 2;
      const imY = (py - centerY - translateY) / scale + nh / 2;
      return { imX, imY };
    };

    const corners = frameCorners.map(([px, py]) => toImageCoords(px, py));
    const minX = Math.max(0, Math.min(...corners.map((c) => c.imX)));
    const minY = Math.max(0, Math.min(...corners.map((c) => c.imY)));
    const maxX = Math.min(nw, Math.max(...corners.map((c) => c.imX)));
    const maxY = Math.min(nh, Math.max(...corners.map((c) => c.imY)));

    const sw = maxX - minX;
    const sh = maxY - minY;
    if (sw <= 0 || sh <= 0) return;

    // Se for adesivo, forçamos o crop final a ser perfeitamente quadrado 1:1
    let safeSx = minX;
    let safeSy = minY;
    let safeW = sw;
    let safeH = sh;
    
    const targetExportW = overlayType === 'number' ? STICKER_EXPORT_SIZE : PLATE_EXPORT_SIZE;
    const targetExportH = overlayType === 'number' ? STICKER_EXPORT_SIZE : PLATE_EXPORT_SIZE;

    if (overlayType === 'number') {
      const minDim = Math.min(sw, sh);
      const cx = minX + sw / 2;
      const cy = minY + sh / 2;
      safeSx = Math.max(0, Math.min(nw - minDim, cx - minDim / 2));
      safeSy = Math.max(0, Math.min(nh - minDim, cy - minDim / 2));
      safeW = minDim;
      safeH = minDim;
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetExportW;
    canvas.height = targetExportH;
    const ctx = canvas.getContext('2d')!;

    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, safeSx, safeSy, safeW, safeH, 0, 0, targetExportW, targetExportH);
      canvas.toBlob(
        (blob) => {
          if (blob) onConfirm(blob, canvas.toDataURL('image/jpeg', 0.92));
        },
        'image/jpeg',
        0.92
      );
    };
    img.src = imageUrl;
  }, [getContainerRect, getFrameSize, imgSize, scale, translateX, translateY, imageUrl, overlayType, onConfirm]);

  const handleReset = useCallback(() => {
    setScale(1);
    setTranslateX(0);
    setTranslateY(0);
  }, []);

  const transform = `translate(-50%, -50%) scale(${scale}) translate(${translateX}px, ${translateY}px)`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between p-3 border-b border-border/50 bg-card">
        <h2 className="text-lg font-bold text-foreground">
          {overlayType === 'number' ? 'Enquadrar Adesivo' : 'Enquadrar Placa'}
        </h2>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={handleReset} className="text-xs font-semibold text-muted-foreground">
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Redefinir
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden bg-black touch-none"
        style={{ minHeight: 0, touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={() => { lastPinchRef.current = null; }}
        onWheel={handleWheel}
      >
        <div className="absolute inset-0 flex items-center justify-center">
          <img
            ref={imgRef}
            src={imageUrl}
            alt="Enquadrar"
            className="absolute max-w-none select-none pointer-events-none"
            style={{
              width: imgSize.w,
              height: imgSize.h,
              left: '50%',
              top: '50%',
              transform,
            }}
            draggable={false}
          />
        </div>

        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden>
          <div
            className={`border-2 border-primary rounded-lg bg-primary/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.7)] transition-all`}
            style={{
              width: overlayType === 'number' ? `min(${STICKER_FRAME_VW}vw, ${STICKER_FRAME_MAX_PX}px)` : `min(${PLATE_FRAME_VW}vw, ${PLATE_FRAME_MAX_PX}px)`,
              height: overlayType === 'number' ? `min(${STICKER_FRAME_VW}vw, ${STICKER_FRAME_MAX_PX}px)` : `min(${PLATE_FRAME_VW}vw, ${PLATE_FRAME_MAX_PX}px)`,
            }}
          />
        </div>

        <div className="absolute bottom-16 left-0 right-0 flex justify-center pointer-events-none">
          <p className="bg-black/60 px-4 py-2 rounded-full text-xs font-medium text-white flex items-center gap-2 backdrop-blur-sm">
            <Move className="h-3.5 w-3.5" />
            Arraste e use o movimento de pinça (zoom) para encaixar
          </p>
        </div>
      </div>

      <div className="flex gap-3 p-4 bg-card border-t border-border/50 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button variant="outline" className="flex-1 h-14 text-base font-semibold rounded-xl" onClick={onCancel}>
          Cancelar
        </Button>
        <Button className="flex-1 h-14 text-base font-bold rounded-xl shadow-md" onClick={exportCrop}>
          <Check className="mr-2 h-5 w-5" />
          Usar esta foto
        </Button>
      </div>
    </div>
  );
}