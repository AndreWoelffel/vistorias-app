/**
 * Baixa os modelos de leitura de placa e adesivo enquanto há sinal, para o
 * service worker guardá-los (cache "modelos-leitura"). Assim o leitor funciona
 * no pátio mesmo sem internet, inclusive na primeira vistoria do dia.
 */
const MODELOS = ['/model_yolo_placas', '/model_yolo_vistorias', '/model_cnn'];
const CHAVE = 'vistoria.modelosGuardados';

type Manifesto = { weightsManifest?: { paths?: string[] }[] };

async function baixarModelo(base: string): Promise<void> {
  const resp = await fetch(`${base}/model.json`);
  if (!resp.ok) throw new Error(`${base}: ${resp.status}`);
  const manifesto = (await resp.json()) as Manifesto;
  const arquivos = (manifesto.weightsManifest ?? []).flatMap((g) => g.paths ?? []);
  for (const arquivo of arquivos) {
    const r = await fetch(`${base}/${arquivo}`);
    if (!r.ok) throw new Error(`${base}/${arquivo}: ${r.status}`);
    await r.arrayBuffer();
  }
}

let emAndamento = false;

export async function guardarModelosNoAparelho(versao: string): Promise<void> {
  if (emAndamento || !navigator.serviceWorker?.controller) return;
  if (localStorage.getItem(CHAVE) === versao) return;
  emAndamento = true;
  try {
    for (const base of MODELOS) await baixarModelo(base);
    localStorage.setItem(CHAVE, versao);
  } catch {
    /* tenta de novo na próxima vez que houver sinal */
  } finally {
    emAndamento = false;
  }
}
