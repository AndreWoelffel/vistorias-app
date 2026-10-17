import { beforeEach, describe, expect, it, vi } from 'vitest';

const estado = vi.hoisted(() => ({
  existe: false,
  erroInsert: null as { code?: string; message: string } | null,
  existeDepoisDoErro: false,
}));

vi.mock('@/services/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => Promise.resolve({ data: estado.existe ? [{ vistoria_id: 'v' }] : [], error: null }),
          }),
        }),
      }),
      insert: () => {
        if (estado.erroInsert) {
          estado.existe = estado.existeDepoisDoErro;
          return Promise.resolve({ error: estado.erroInsert });
        }
        estado.existe = true;
        return Promise.resolve({ error: null });
      },
    }),
  },
}));

import { garantirVinculoLeilao } from './vinculoLeilao';

beforeEach(() => {
  estado.existe = false;
  estado.erroInsert = null;
  estado.existeDepoisDoErro = false;
});

describe('garantirVinculoLeilao', () => {
  it('cria o vínculo quando não existe', async () => {
    expect(await garantirVinculoLeilao('v', 3)).toEqual({ ok: true });
    expect(estado.existe).toBe(true);
  });

  it('não duplica quando já existe', async () => {
    estado.existe = true;
    estado.erroInsert = { code: '23505', message: 'não deveria inserir' };
    expect(await garantirVinculoLeilao('v', 3)).toEqual({ ok: true });
  });

  it('placa repetida no leilão vira duplicidade, não sucesso', async () => {
    estado.erroInsert = { code: '23505', message: 'duplicate_placa_in_leilao' };
    expect(await garantirVinculoLeilao('v', 3)).toEqual({ ok: false, duplicado: 'placa' });
  });

  it('número repetido no leilão vira duplicidade', async () => {
    estado.erroInsert = { code: '23505', message: 'duplicate_num_in_leilao' };
    expect(await garantirVinculoLeilao('v', 3)).toEqual({ ok: false, duplicado: 'numero' });
  });

  it('falha de rede sobe como erro para a fila tentar de novo', async () => {
    estado.erroInsert = { message: 'Failed to fetch' };
    await expect(garantirVinculoLeilao('v', 3)).rejects.toThrow('Failed to fetch');
  });
});
