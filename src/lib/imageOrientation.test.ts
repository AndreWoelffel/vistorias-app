import { describe, expect, it } from 'vitest';

import {
  anguloPelaGravidade,
  encodeOrientationInFileName,
  jaFoiAlinhada,
  parseOrientationFromFileName,
  stripOrientationSuffix,
} from './imageOrientation';

describe('anguloPelaGravidade', () => {
  it('não gira quando o celular está em pé, em retrato', () => {
    expect(anguloPelaGravidade(80, 0, 1)).toBe(0);
    expect(anguloPelaGravidade(90, 5, 1)).toBe(0);
  });

  it('detecta retrato de cabeça para baixo', () => {
    expect(anguloPelaGravidade(-80, 0, 1)).toBe(180);
  });

  it('detecta paisagem para os dois lados', () => {
    expect(anguloPelaGravidade(0, 85, 1)).toBe(90);
    expect(anguloPelaGravidade(0, -85, 1)).toBe(270);
  });

  it('inverte os lados quando o sinal do gamma é invertido', () => {
    expect(anguloPelaGravidade(0, 85, -1)).toBe(270);
    expect(anguloPelaGravidade(0, -85, -1)).toBe(90);
  });

  it('abre mão da decisão com o celular achatado', () => {
    // Caso típico da foto de chassi tirada de cima: a gravidade fica alinhada
    // com o eixo Z e não define horizonte no plano da tela.
    expect(anguloPelaGravidade(5, 5, 1)).toBeNull();
    expect(anguloPelaGravidade(-10, 10, 1)).toBeNull();
  });
});

describe('metadado no nome do arquivo', () => {
  it('insere o sufixo antes da extensão', () => {
    expect(encodeOrientationInFileName('FOTO_ABC1D23_171.jpg', 90, 'sensor')).toBe(
      'FOTO_ABC1D23_171~r90-sensor.jpg',
    );
  });

  it('lida com nome sem extensão', () => {
    expect(encodeOrientationInFileName('CHASSI_ABC1D23', 180, 'manual')).toBe(
      'CHASSI_ABC1D23~r180-manual',
    );
  });

  it('não acumula sufixos ao reprocessar', () => {
    const uma = encodeOrientationInFileName('MOTOR_XYZ.jpg', 90, 'sensor');
    const duas = encodeOrientationInFileName(uma, 270, 'manual');
    expect(duas).toBe('MOTOR_XYZ~r270-manual.jpg');
  });

  it('faz o round-trip da leitura', () => {
    const nome = encodeOrientationInFileName('FOTO_GERAL_9.jpg', 270, 'exif');
    expect(parseOrientationFromFileName(nome)).toEqual({ angulo: 270, fonte: 'exif' });
  });

  it('devolve nulo para foto legada, sem sufixo', () => {
    expect(parseOrientationFromFileName('FOTO_ANTIGA_1.jpg')).toEqual({
      angulo: null,
      fonte: null,
    });
    expect(jaFoiAlinhada('FOTO_ANTIGA_1.jpg')).toBe(false);
  });

  it('reconhece foto já alinhada, garantindo idempotência', () => {
    expect(jaFoiAlinhada('FOTO_X~r90-sensor.jpg')).toBe(true);
  });

  it('preserva o prefixo de tipo, de que o sync depende', () => {
    const nome = encodeOrientationInFileName('CHASSI_ABC1D23.jpg', 90, 'sensor');
    expect(nome.startsWith('CHASSI_')).toBe(true);
  });

  it('remove o sufixo para gravar arquivo_original limpo', () => {
    expect(stripOrientationSuffix('FOTO_X~r90-sensor.jpg')).toBe('FOTO_X.jpg');
    expect(stripOrientationSuffix('FOTO_X.jpg')).toBe('FOTO_X.jpg');
  });

  it('ignora um til que faça parte do nome sem ser o sufixo', () => {
    expect(parseOrientationFromFileName('FOTO~r45-sensor.jpg').angulo).toBeNull();
    expect(parseOrientationFromFileName('FOTO~r90-outro.jpg').angulo).toBeNull();
  });
});
