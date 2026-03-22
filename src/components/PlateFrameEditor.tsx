import { useRef, useState, useCallback, useEffect } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const FRAME_SIZE_VW = 78;
const FRAME_MAX_PX = 320;
const EXPORT_SIZE = 640;

interface PlateFrameEditorProps {
  imageUrl: string;
  imageBlob: Blob;
  onConfirm: (blob: Blob, dataUrl: string) => void;
  onCancel: () => void;
}

export function PlateFrameEditor({ imageUrl, imageBlob, onConfirm, onCancel }: PlateFrameEditorProps) {
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
    const side = Math.min(rect.width * (FRAME_SIZE_VW / 100), FRAME_MAX_PX);
    return { side, left: (rect.width - side) / 2, top: (rect.height - side) / 2 };
  }, [getContainerRect]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setIsDragging(true);
      setLastPointer({ x: e.clientX, y: e.clientY });
      lastPinchRef.current = null;
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging) return;
      lastPinchRef.current = null;
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      setTranslateX((t) => t + dx);
      setTranslateY((t) => t + dy);
      setLastPointer({ x: e.clientX, y: e.clientY });
    },
    [isDragging, lastPointer]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setIsDragging(false);
    lastPinchRef.current = null;
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
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
    },
    []
  );

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

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = getContainerRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const newScale = Math.max(0.3, Math.min(5, scale + delta));
      setScale(newScale);
    },
    [scale, getContainerRect]
  );

  const exportCrop = useCallback(() => {
    const rect = getContainerRect();
    const { side, left: frameLeft, top: frameTop } = getFrameSize();
    const nw = imgSize.w;
    const nh = imgSize.h;
    if (nw === 0 || nh === 0) return;

    const W = rect.width;
    const H = rect.height;
    const centerX = W / 2;
    const centerY = H / 2;

    const frameCorners = [
      [frameLeft, frameTop],
      [frameLeft + side, frameTop],
      [frameLeft, frameTop + side],
      [frameLeft + side, frameTop + side],
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

    const minDim = Math.min(sw, sh);
    const cx = minX + sw / 2;
    const cy = minY + sh / 2;
    const safeSx = Math.max(0, Math.min(nw - minDim, cx - minDim / 2));
    const safeSy = Math.max(0, Math.min(nh - minDim, cy - minDim / 2));
    const safeDim = minDim;

    const canvas = document.createElement('canvas');
    canvas.width = EXPORT_SIZE;
    canvas.height = EXPORT_SIZE;
    const ctx = canvas.getContext('2d')!;

    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, safeSx, safeSy, safeDim, safeDim, 0, 0, EXPORT_SIZE, EXPORT_SIZE);
      canvas.toBlob(
        (blob) => {
          if (blob) onConfirm(blob, canvas.toDataURL('image/jpeg', 0.92));
        },
        'image/jpeg',
        0.92
      );
    };
    img.src = imageUrl;
  }, [getContainerRect, getFrameSize, imgSize, scale, translateX, translateY, imageUrl, onConfirm]);

  const handleReset = useCallback(() => {
    setScale(1);
    setTranslateX(0);
    setTranslateY(0);
  }, []);

  const transform = `translate(-50%, -50%) scale(${scale}) translate(${translateX}px, ${translateY}px)`;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between p-2">
        <h2 className="text-lg font-bold text-foreground">Enquadrar placa</h2>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={handleReset}>
            <RotateCcw className="h-4 w-4 mr-1" />
            Redefinir
          </Button>
          <Button variant="ghost" size="icon" onClick={onCancel}>
            ✕
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

        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          aria-hidden
        >
          <div
            className="plate-frame-mira border-2 border-green-500 rounded-lg bg-green-500/10"
            style={{
              width: `min(${FRAME_SIZE_VW}vw, ${FRAME_MAX_PX}px)`,
              aspectRatio: '1',
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.65)',
            }}
          />
        </div>

        <p className="absolute bottom-20 left-0 right-0 text-center text-sm text-white/90 pointer-events-none">
          Arraste e use zoom para encaixar a placa no quadrado verde. Depois toque em Enviar.
        </p>
      </div>

      <div className="flex gap-3 p-4">
        <Button variant="secondary" className="flex-1 h-14 text-base" onClick={onCancel}>
          Voltar
        </Button>
        <Button className="flex-1 h-14 text-base font-bold" onClick={exportCrop}>
          <Check className="mr-2 h-5 w-5" />
          Enviar
        </Button>
      </div>
    </div>
  );
}
