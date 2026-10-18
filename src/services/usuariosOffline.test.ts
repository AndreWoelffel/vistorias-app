import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/supabaseClient', () => ({
  supabase: {
    from: () => ({
      select: () =>
        Promise.resolve({
          data: [
            { id: 'u1', nome: 'Dionathan', role: 'vistoriador', ativo: true, senha: '1234' },
            { id: 'u2', nome: 'Leandro', role: 'vistoriador', ativo: false, senha: '5555' },
            { id: 'u3', nome: 'André', role: 'admin', ativo: true, senha: '9999' },
          ],
          error: null,
        }),
    }),
  },
}));

import { entrarSemInternet, guardarUsuariosNoAparelho, usuariosGuardados } from './usuariosOffline';

beforeEach(() => localStorage.clear());

describe('login sem internet', () => {
  it('sem lista guardada não entra', () => {
    expect(usuariosGuardados('vistoriador')).toBeNull();
    expect(entrarSemInternet('u1', '1234')).toBeNull();
  });

  it('guarda a lista sem o PIN em texto e entra com o PIN certo', async () => {
    await guardarUsuariosNoAparelho();
    expect(localStorage.getItem('vistoria.usuariosGuardados')).not.toContain('1234');
    expect(usuariosGuardados('vistoriador')?.usuarios.map((u) => u.nome)).toEqual(['Dionathan']);
    expect(entrarSemInternet('u1', '1234')?.nome).toBe('Dionathan');
    expect(entrarSemInternet('u1', '0000')).toBeNull();
  });

  it('usuário desativado não entra nem aparece', async () => {
    await guardarUsuariosNoAparelho();
    expect(entrarSemInternet('u2', '5555')).toBeNull();
  });
});
