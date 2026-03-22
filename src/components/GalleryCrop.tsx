import { useRef, useState, useCallback, useEffect } from 'react';
import { X, Check, ZoomIn, ZoomOut, Move } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';

interface GalleryCropProps {
  imageUrl: string;
  imageBlob: Blob;
  overlayType: 'plate' | 'number';
  /** '1:1' = quadrado (adesivo YOLO); 'free' = retângulo livre */
  cropAspectRatio?: '1:1' | 'free';
  onConfirm: (croppedBlob: Blob) => void;
  onCancel: () => void;
}

export function GalleryCrop({ imageUrl, imageBlob, overlayType, cropAspectRatio = 'free', onConfirm, onCancel }: GalleryCropProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [imgLoaded, setImgLoaded] = useState(false);

  // Pinch-to-zoom state
  const [initialPinchDist, setInitialPinchDist] = useState<number | null>(null);
  const [initialPinchZoom, setInitialPinchZoom] = useState(1);

  // ROI inicial: 1:1 (adesivo) ou retângulo livre (placa/número)
  const initialRoi = cropAspectRatio === '1:1'
    ? (() => { const s = 0.5; return { x: (1 - s) / 2, y: (1 - s) / 2, w: s, h: s }; })()
    : overlayType === 'plate'
      ? { x: (1 - 0.65) / 2, y: (1 - 0.22) / 2, w: 0.65, h: 0.22 }
      : { x: (1 - 0.45) / 2, y: (1 - 0.18) / 2, w: 0.45, h: 0.18 };

  const [roi, setRoi] = useState(initialRoi);
  const [roiMode, setRoiMode] = useState<null | 'move' | 'nw' | 'ne' | 'sw' | 'se'>(null);
  const [roiPointerStart, setRoiPointerStart] = useState<{ x: number; y: number } | null>(null);
  const [roiStart, setRoiStart] = useState(initialRoi);

  useEffect(() => {
    // If overlayType changes (rare), reset ROI defaults.
    setRoi(initialRoi);
    setRoiStart(initialRoi);
  }, [overlayType]); // eslint-disable-line react-hooks/exhaustive-deps

  const clampRoi = useCallback((r: typeof roi) => {
    const minSide = 0.12;
    let w = Math.max(minSide, Math.min(1, r.w));
    let h = Math.max(minSide, Math.min(1, r.h));
    if (cropAspectRatio === '1:1') {
      const side = Math.min(w, h);
      w = side;
      h = side;
    }
    const x = Math.max(0, Math.min(1 - w, r.x));
    const y = Math.max(0, Math.min(1 - h, r.y));
    return { x, y, w, h };
  }, [cropAspectRatio]);

  const startRoiInteraction = useCallback((mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setRoiMode(mode);
    setRoiPointerStart({ x: e.clientX, y: e.clientY });
    setRoiStart(roi);
  }, [roi]);

  const updateRoiFromPointer = useCallback((e: React.PointerEvent) => {
    if (!roiMode || !roiPointerStart || !containerRef.current) return;
    e.stopPropagation();
    const rect = containerRef.current.getBoundingClientRect();
    const dx = (e.clientX - roiPointerStart.x) / rect.width;
    const dy = (e.clientY - roiPointerStart.y) / rect.height;

    let next = { ...roiStart };
    if (roiMode === 'move') {
      next.x = roiStart.x + dx;
      next.y = roiStart.y + dy;
    } else if (roiMode === 'nw') {
      next.x = roiStart.x + dx;
      next.y = roiStart.y + dy;
      next.w = roiStart.w - dx;
      next.h = roiStart.h - dy;
    } else if (roiMode === 'ne') {
      next.y = roiStart.y + dy;
      next.w = roiStart.w + dx;
      next.h = roiStart.h - dy;
    } else if (roiMode === 'sw') {
      next.x = roiStart.x + dx;
      next.w = roiStart.w - dx;
      next.h = roiStart.h + dy;
    } else if (roiMode === 'se') {
      next.w = roiStart.w + dx;
      next.h = roiStart.h + dy;
    }
    if (cropAspectRatio === '1:1' && roiMode !== 'move') {
      const side = Math.max(next.w, next.h);
      next.w = side;
      next.h = side;
    }

    setRoi(clampRoi(next));
  }, [roiMode, roiPointerStart, roiStart, clampRoi, cropAspectRatio]);

  const endRoiInteraction = useCallback((e?: React.PointerEvent) => {
    if (e) e.stopPropagation();
    setRoiMode(null);
    setRoiPointerStart(null);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return; // handled by touch events
    setDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  }, [offset]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging || e.pointerType === 'touch') return;
    setOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [dragging, dragStart]);

  const handlePointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  // Touch: drag + pinch-to-zoom
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      setInitialPinchDist(dist);
      setInitialPinchZoom(zoom);
    } else if (e.touches.length === 1) {
      setDragging(true);
      setDragStart({ x: e.touches[0].clientX - offset.x, y: e.touches[0].clientY - offset.y });
    }
  }, [zoom, offset]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 2 && initialPinchDist !== null) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const newZoom = Math.max(0.5, Math.min(5, initialPinchZoom * (dist / initialPinchDist)));
      setZoom(newZoom);
    } else if (e.touches.length === 1 && dragging) {
      setOffset({ x: e.touches[0].clientX - dragStart.x, y: e.touches[0].clientY - dragStart.y });
    }
  }, [initialPinchDist, initialPinchZoom, dragging, dragStart]);

  const handleTouchEnd = useCallback(() => {
    setDragging(false);
    setInitialPinchDist(null);
  }, []);

  const handleConfirm = useCallback(() => {
    if (!imgRef.current || !containerRef.current) return;

    const container = containerRef.current.getBoundingClientRect();
    const img = imgRef.current;

    // ROI rectangle in container coordinates
    const roiX = container.width * roi.x;
    const roiY = container.height * roi.y;
    const roiW = container.width * roi.w;
    const roiH = container.height * roi.h;

    // Image display dimensions
    const imgDisplayW = img.naturalWidth * zoom * (container.width / img.naturalWidth);
    const imgDisplayH = img.naturalHeight * zoom * (container.height / img.naturalHeight);

    // Fit image to container maintaining aspect ratio
    const containerAspect = container.width / container.height;
    const imgAspect = img.naturalWidth / img.naturalHeight;
    let displayW: number, displayH: number;
    if (imgAspect > containerAspect) {
      displayW = container.width * zoom;
      displayH = (container.width / imgAspect) * zoom;
    } else {
      displayH = container.height * zoom;
      displayW = container.height * imgAspect * zoom;
    }

    // Image top-left in container coords
    const imgLeft = (container.width - displayW) / 2 + offset.x;
    const imgTop = (container.height - displayH) / 2 + offset.y;

    // Map ROI to image natural coordinates
    const scaleX = img.naturalWidth / displayW;
    const scaleY = img.naturalHeight / displayH;

    const rawCropX = Math.max(0, (roiX - imgLeft) * scaleX);
    const rawCropY = Math.max(0, (roiY - imgTop) * scaleY);
    const rawCropW = Math.min(img.naturalWidth - rawCropX, roiW * scaleX);
    const rawCropH = Math.min(img.naturalHeight - rawCropY, roiH * scaleY);

    // Add 15% padding for OCR breathing room
    const padX = rawCropW * 0.15;
    const padY = rawCropH * 0.15;
    let cropX = Math.max(0, rawCropX - padX);
    let cropY = Math.max(0, rawCropY - padY);
    let cropW = Math.min(img.naturalWidth - cropX, rawCropW + padX * 2);
    let cropH = Math.min(img.naturalHeight - cropY, rawCropH + padY * 2);

    if (cropAspectRatio === '1:1') {
      const side = Math.min(cropW, cropH);
      const cx = cropX + cropW / 2;
      const cy = cropY + cropH / 2;
      cropW = side;
      cropH = side;
      cropX = Math.max(0, Math.min(img.naturalWidth - side, cx - side / 2));
      cropY = Math.max(0, Math.min(img.naturalHeight - side, cy - side / 2));
    }

    // Draw cropped region with padding, white background for OCR
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cropW));
    canvas.height = Math.max(1, Math.round(cropH));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (blob) onConfirm(blob);
    }, 'image/jpeg', 0.95);
  }, [zoom, offset, roi, cropAspectRatio, onConfirm]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between p-4">
        <h2 className="text-lg font-bold text-foreground">Ajuste de Enquadramento</h2>
        <Button variant="ghost" size="icon" onClick={onCancel}>
          <X className="h-6 w-6" />
        </Button>
      </div>

      <p className="px-4 pb-2 text-sm text-muted-foreground">
        <Move className="inline h-4 w-4 mr-1" />
        Arraste e use pinch-to-zoom para encaixar a placa no retângulo.
      </p>

      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden bg-black touch-none"
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <img
          ref={imgRef}
          src={imageUrl}
          alt="Imagem para enquadrar"
          className="absolute inset-0 h-full w-full object-contain pointer-events-none"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
          }}
          onLoad={() => setImgLoaded(true)}
        />

        {/* ROI overlay */}
        <div className="absolute inset-0 pointer-events-none">
          {/* Dark mask around ROI */}
          <div className="absolute inset-0 bg-black/50" />
          {/* Clear ROI window (free crop) */}
          <div
            className="absolute border-2 border-accent bg-transparent pointer-events-auto"
            style={{
              left: `${roi.x * 100}%`,
              top: `${roi.y * 100}%`,
              width: `${roi.w * 100}%`,
              height: `${roi.h * 100}%`,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
            }}
            onPointerDown={startRoiInteraction('move')}
            onPointerMove={updateRoiFromPointer}
            onPointerUp={endRoiInteraction}
            onPointerCancel={endRoiInteraction}
            onPointerLeave={endRoiInteraction}
          >
            {/* Resize handles */}
            {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
              <div
                key={h}
                className="absolute h-4 w-4 rounded-sm bg-accent"
                style={{
                  left: h.includes('w') ? -8 : undefined,
                  right: h.includes('e') ? -8 : undefined,
                  top: h.includes('n') ? -8 : undefined,
                  bottom: h.includes('s') ? -8 : undefined,
                }}
                onPointerDown={startRoiInteraction(h)}
                onPointerMove={updateRoiFromPointer}
                onPointerUp={endRoiInteraction}
                onPointerCancel={endRoiInteraction}
              />
            ))}
          </div>
          <div
            className="absolute text-center"
            style={{
              left: `${roi.x * 100}%`,
              top: `${(roi.y + roi.h) * 100 + 2}%`,
              width: `${roi.w * 100}%`,
            }}
          >
            <p className="text-xs font-medium text-foreground/80">
              {overlayType === 'plate'
                ? 'Corte livre: ajuste o retângulo na placa'
                : 'Corte quadrado: enquadre a logo e o número (1:1)'}
            </p>
          </div>
        </div>
      </div>

      {/* Zoom slider */}
      <div className="flex items-center gap-3 px-4 py-3">
        <ZoomOut className="h-4 w-4 text-muted-foreground shrink-0" />
        <Slider
          value={[zoom]}
          min={0.5}
          max={5}
          step={0.1}
          onValueChange={([v]) => setZoom(v)}
          className="flex-1"
        />
        <ZoomIn className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-xs font-mono text-muted-foreground w-10 text-right">{zoom.toFixed(1)}x</span>
      </div>

      <div className="flex gap-3 p-4">
        <Button variant="secondary" className="flex-1 h-14 text-base" onClick={onCancel}>
          <X className="mr-2 h-5 w-5" />
          Cancelar
        </Button>
        <Button className="flex-1 h-14 text-base font-bold" onClick={handleConfirm}>
          <Check className="mr-2 h-5 w-5" />
          Confirmar Enquadramento
        </Button>
      </div>
    </div>
  );
}
