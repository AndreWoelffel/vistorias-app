// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FotoRow = { id: string; vistoria_id: string; tipo: string; ordem: number; storage_path: string; sha256: string };

const nuvem = vi.hoisted(() => ({
  fotos: [] as FotoRow[],
  uploads: [] as string[],
  removidos: [] as string[],
}));

vi.mock('@/services/supabaseClient', () => {
  const tabela = () => ({
    select: () => ({
      eq: (_col: string, vistoriaId: string) =>
        Promise.resolve({ data: nuvem.fotos.filter((f) => f.vistoria_id === vistoriaId), error: null }),
    }),
    delete: () => ({
      in: (_col: string, ids: string[]) => {
        nuvem.fotos = nuvem.fotos.filter((f) => !ids.includes(f.id));
        return Promise.resolve({ error: null });
      },
    }),
    upsert: (row: FotoRow) => {
      nuvem.fotos = nuvem.fotos.filter(
        (f) => !(f.vistoria_id === row.vistoria_id && f.tipo === row.tipo && f.ordem === row.ordem),
      );
      nuvem.fotos.push({ ...row, id: `${row.tipo}-${row.ordem}-${nuvem.uploads.length}` });
      return Promise.resolve({ error: null });
    },
  });
  return {
    supabase: {
      from: () => tabela(),
      storage: {
        from: () => ({
          upload: (path: string) => {
            nuvem.uploads.push(path);
            return Promise.resolve({ error: null });
          },
          remove: (paths: string[]) => {
            nuvem.removidos.push(...paths);
            return Promise.resolve({ error: null });
          },
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://x/${path}` } }),
        }),
      },
    },
  };
});

import { syncVistoriaFotosToCloud } from './vistoriaFotoService';
import { sha256HexFromBlob } from '@/lib/sha256';

const VID = 'v-1';

function foto(nome: string, conteudo: string): File {
  return new File([conteudo], nome, { type: 'image/jpeg' });
}

function naNuvem(tipo: string, ordem: number, sha256: string): FotoRow {
  return { id: `${tipo}-${ordem}`, vistoria_id: VID, tipo, ordem, storage_path: `3/${VID}/${tipo}_${ordem}.jpg`, sha256 };
}

beforeEach(() => {
  nuvem.fotos = [];
  nuvem.uploads = [];
  nuvem.removidos = [];
});

describe('syncVistoriaFotosToCloud', () => {
  it('vistoria baixada sem fotos não apaga as fotos da nuvem', async () => {
    nuvem.fotos = [naNuvem('placa', 0, 'a'), naNuvem('chassi', 0, 'b')];
    const r = await syncVistoriaFotosToCloud({ leilaoFk: 3, vistoriaCloudId: VID, fotos: [] });
    expect(nuvem.removidos).toEqual([]);
    expect(nuvem.fotos).toHaveLength(2);
    expect(r.uploadFailed).toBe(false);
  });

  it('foto girada pelo Operador não é sobrescrita pela original do celular', async () => {
    const chassi = foto('CHASSI_ABC1234_1.jpg', 'original');
    const shaLocal = await sha256HexFromBlob(chassi);
    nuvem.fotos = [naNuvem('chassi', 0, 'sha-depois-do-giro')];
    const r = await syncVistoriaFotosToCloud({
      leilaoFk: 3,
      vistoriaCloudId: VID,
      fotos: [chassi],
      enviadasAntes: { 'chassi:0': shaLocal },
    });
    expect(nuvem.uploads).toEqual([]);
    expect(nuvem.fotos[0].sha256).toBe('sha-depois-do-giro');
    expect(r.enviadas['chassi:0']).toBe(shaLocal);
  });

  it('foto trocada no celular sobe de novo', async () => {
    const nova = foto('CHASSI_ABC1234_2.jpg', 'nova');
    nuvem.fotos = [naNuvem('chassi', 0, 'sha-antiga')];
    await syncVistoriaFotosToCloud({
      leilaoFk: 3,
      vistoriaCloudId: VID,
      fotos: [nova],
      enviadasAntes: { 'chassi:0': 'sha-antiga' },
    });
    expect(nuvem.uploads).toEqual([`3/${VID}/chassi_0.jpg`]);
  });

  it('só apaga da nuvem a foto que este celular enviou e o vistoriador tirou', async () => {
    nuvem.fotos = [naNuvem('motor', 0, 'm'), naNuvem('geral', 5, 'do-operador')];
    await syncVistoriaFotosToCloud({
      leilaoFk: 3,
      vistoriaCloudId: VID,
      fotos: [],
      enviadasAntes: { 'motor:0': 'm' },
    });
    expect(nuvem.removidos).toEqual([`3/${VID}/motor_0.jpg`]);
    expect(nuvem.fotos.map((f) => f.tipo)).toEqual(['geral']);
  });

  it('primeiro envio sobe tudo e devolve o que foi enviado', async () => {
    const placa = foto('PLACA_ABC1234.jpg', 'p');
    const geral = foto('FOTO_ABC1234_1.jpg', 'g');
    const r = await syncVistoriaFotosToCloud({ leilaoFk: 3, vistoriaCloudId: VID, fotos: [placa, geral] });
    expect(nuvem.uploads).toHaveLength(2);
    expect(Object.keys(r.enviadas).sort()).toEqual(['geral:0', 'placa:0']);
    expect(r.placaPublicUrl).toBe(`https://x/3/${VID}/placa_0.jpg`);
  });
});
