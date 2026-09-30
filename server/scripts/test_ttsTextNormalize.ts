import { normalizeTtsText } from '../src/utils/ttsTextNormalize';

function assertEqual(actual: string, expected: string) {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assertEqual(normalizeTtsText('项目 KES 方案'), '项目 K E S 方案');
assertEqual(normalizeTtsText('KES和AI模型'), 'K E S和A I模型');
assertEqual(normalizeTtsText('已是 K E S'), '已是 K E S');
assertEqual(normalizeTtsText('iPhone 很好'), 'iPhone 很好');
assertEqual(normalizeTtsText('NASA-2024'), 'N A S A-2024');
assertEqual(normalizeTtsText(''), '');

console.log('ttsTextNormalize ok');
