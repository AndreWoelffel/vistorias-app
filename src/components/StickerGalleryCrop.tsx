import { useRef, useCallback, useState, useMemo } from 'react';
import { X, Check, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';

/**
 * Galeria do Passo 2 (Adesivo): pan + zoom com viewport quadrada 1:1.
 * O recorte final reflete o enquadramento visual (centro do quadrado → imagem natural).
 */
interface StickerGalleryCropProps {
  imageUrl: string;
  imageBlob: Blob;
  onConfirm: (croppedBlob: Blob) => void;
  onCancel: () => void;
}

const PREVIEW_SIZE_PX = 320;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

export function StickerGalleryCrop({ imageUrl, imageBlob: _imageBlob, onConfirm, onCancel }: StickerGalleryCropProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [nw, setNw] = useState(0);
  const [nh, setNh] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [lastPointer, setLastPointer] = useState({ x: 0, y: 0 });

  const W = PREVIEW_SIZE_PX;

  const fit = useMemo(() => {
    if (!nw || !nh) return 1;
    return Math.min(W / nw, W / nh);
  }, [nw, nh, W]);

  const dispW = nw * fit * zoom;
  const dispH = nh * fit * zoom;
  const imgLeft = (W - dispW) / 2 + panX;
  const imgTop = (W - dispH) / 2 + panY;

  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    setNw(img.naturalWidth);
    setNh(img.naturalHeight);
    setImageLoaded(true);
    setZoom(1);
    setPanX(0);
    setPanY(0);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    setLastPointer({ x: e.clientX, y: e.clientY });
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      setPanX((p) => p + dx);
      setPanY((p) => p + dy);
      setLastPointer({ x: e.clientX, y: e.clientY });
    },
    [dragging, lastPointer]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragging(false);
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta)));
    },
    []
  );

  const handleConfirm = useCallback(() => {
    const img = imgRef.current;
    if (!img || !nw || !nh || dispW <= 0 || dispH <= 0) return;

    let u = (W / 2 - imgLeft) / dispW;
    let v = (W / 2 - imgTop) / dispH;
    u = Math.max(0, Math.min(1, u));
    v = Math.max(0, Math.min(1, v));
    const cx = u * nw;
    const cy = v * nh;

    const sideFromX = (W * nw) / dispW;
    const sideFromY = (W * nh) / dispH;
    let cropSide = Math.min(sideFromX, sideFromY, nw, nh);
    cropSide = Math.floor(cropSide);
    if (cropSide < 1) return;

    let startX = Math.round(cx - cropSide / 2);
    let startY = Math.round(cy - cropSide / 2);
    startX = Math.max(0, Math.min(nw - cropSide, startX));
    startY = Math.max(0, Math.min(nh - cropSide, startY));

    const canvas = document.createElement('canvas');
    canvas.width = cropSide;
    canvas.height = cropSide;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(img, startX, startY, cropSide, cropSide, 0, 0, cropSide, cropSide);

    canvas.toBlob(
      (blob) => {
        if (blob) onConfirm(blob);
      },
      'image/jpeg',
      0.92
    );
  }, [onConfirm, nw, nh, W, imgLeft, imgTop, dispW, dispH]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between p-4">
        <h2 className="text-lg font-bold text-foreground">Adesivo — Enquadramento</h2>
        <Button variant="ghost" size="icon" onClick={onCancel}>
          <X className="h-6 w-6" />
        </Button>
      </div>

      <p className="px-4 pb-2 text-sm text-muted-foreground">
        Arraste a foto para centralizar a logo e o número no quadrado abaixo. Use a roda do mouse ou o controle de zoom para aproximar.
      </p>

      <div className="flex-1 flex flex-col items-center justify-center overflow-hidden bg-black p-4 gap-3">
        <div
          className="relative flex-shrink-0 rounded-lg border-2 border-green-500 bg-black overflow-hidden touch-none"
          style={{
            width: W,
            height: W,
            aspectRatio: '1',
            touchAction: 'none',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        >
          <img
            ref={imgRef}
            src={imageUrl}
            alt="Preview"
            draggable={false}
            className="absolute select-none max-w-none"
            style={{
              width: dispW,
              height: dispH,
              left: imgLeft,
              top: imgTop,
            }}
            onLoad={handleImageLoad}
          />
        </div>

        <div className="flex items-center gap-3 w-full max-w-xs px-2">
          <ZoomOut className="h-4 w-4 text-muted-foreground shrink-0" />
          <Slider
            value={[zoom]}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={0.05}
            onValueChange={([v]) => setZoom(v)}
            className="flex-1"
          />
          <ZoomIn className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs font-mono text-muted-foreground w-10 text-right">{zoom.toFixed(2)}×</span>
        </div>
      </div>

      <div className="flex gap-3 p-4">
        <Button variant="secondary" className="flex-1 h-14 text-base" onClick={onCancel}>
          <X className="mr-2 h-5 w-5" />
          Cancelar
        </Button>
        <Button className="flex-1 h-14 text-base font-bold" onClick={handleConfirm} disabled={!imageLoaded}>
          <Check className="mr-2 h-5 w-5" />
          Confirmar Enquadramento
        </Button>
      </div>
    </div>
  );
}
