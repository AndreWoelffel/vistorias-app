/**
 * Painel de validação em campo do alinhamento automático.
 *
 * Existe porque a convenção de sinal do `gamma` do DeviceOrientationEvent varia
 * entre navegadores e não há como determinar a correta sem um aparelho na mão.
 * Com este painel, o teste é: virar o celular e conferir se o ângulo mostrado
 * corresponde ao giro físico. Se estiver espelhado, o botão inverte o sinal e
 * grava a escolha no localStorage — sem redeploy.
 *
 * Ativar: localStorage.setItem('vistoria.debugOrientacao', 'on')
 */
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  getSinalGamma,
  isAutoAlinharAtivo,
  readDeviceOrientation,
  setAutoAlinharAtivo,
  setSinalGamma,
  type OrientationReading,
} from '@/lib/imageOrientation';

const FLAG_DEBUG = 'vistoria.debugOrientacao';

export function isOrientationDebugAtivo(): boolean {
  try {
    return localStorage.getItem(FLAG_DEBUG) === 'on';
  } catch {
    return false;
  }
}

function fmt(v: number | null): string {
  return v === null ? '—' : v.toFixed(0).padStart(4, ' ');
}

export function OrientationDebugOverlay() {
  const [leitura, setLeitura] = useState<OrientationReading | null>(null);
  const [sinal, setSinal] = useState<1 | -1>(getSinalGamma());
  const [auto, setAuto] = useState<boolean>(isAutoAlinharAtivo());

  useEffect(() => {
    const id = window.setInterval(() => setLeitura(readDeviceOrientation()), 200);
    return () => window.clearInterval(id);
  }, []);

  const s = leitura?.sinais;

  return (
    <div className="absolute left-2 top-2 z-20 w-56 space-y-2 rounded-lg bg-black/80 p-3 font-mono text-[11px] text-white backdrop-blur-sm">
      <p className="font-bold tracking-wide text-primary">ORIENTAÇÃO (debug)</p>

      <div className="space-y-0.5 tabular-nums">
        <p>beta (pitch) : {fmt(s?.beta ?? null)}°</p>
        <p>gamma (roll) : {fmt(s?.gamma ?? null)}°</p>
        <p>tela         : {fmt(s?.screenAngle ?? null)}°</p>
        <p className="text-amber-300">
          achatado     : {s?.achatado ? 'SIM (não gira)' : 'não'}
        </p>
      </div>

      <div className="border-t border-white/20 pt-1.5">
        <p className="text-sm font-bold text-emerald-400">
          girar {leitura?.angulo ?? 0}° · {leitura?.fonte ?? 'none'}
        </p>
      </div>

      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          className="h-7 flex-1 px-2 text-[10px]"
          onClick={() => {
            const novo: 1 | -1 = sinal === 1 ? -1 : 1;
            setSinalGamma(novo);
            setSinal(novo);
          }}
        >
          gamma {sinal === 1 ? '+' : '−'}
        </Button>
        <Button
          size="sm"
          variant={auto ? 'secondary' : 'destructive'}
          className="h-7 flex-1 px-2 text-[10px]"
          onClick={() => {
            const novo = !auto;
            setAutoAlinharAtivo(novo);
            setAuto(novo);
          }}
        >
          auto {auto ? 'on' : 'off'}
        </Button>
      </div>
    </div>
  );
}
