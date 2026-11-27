"""Testes do versiculo_diario.py. Correr: python -m unittest discover -s tests"""
import datetime
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import versiculo_diario as vd  # noqa: E402


class TestCarregar(unittest.TestCase):

    def test_ficheiro_real(self) -> None:
        lista = vd.carregar_versiculos(vd.FICHEIRO_VERSICULOS)
        self.assertEqual(len(lista), 1826)
        self.assertEqual(lista[0]["referencia"], "Jeremias 29:11")

    def test_formato_amostra(self) -> None:
        dados = {"dias": [
            {"dia": 21, "referencia": "Salmos 119:133", "versiculo": "Firma  os meus passos.",
             "crenca": "As Escrituras Sagradas", "aplicacao_pratica": "Peça a Deus."},
            {"dia": 1, "referencia": "2 Timóteo 3:16", "versiculo": "Toda a Escritura...",
             "crenca": "As Escrituras Sagradas", "aplicacao_pratica": "Leia."},
        ]}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.json"
            p.write_text(json.dumps(dados), encoding="utf-8")
            lista = vd.carregar_versiculos(p)
        self.assertEqual(lista[0]["referencia"], "2 Timóteo 3:16")  # ordenado por dia
        self.assertEqual(lista[1]["texto"], "Firma os meus passos.")  # espaços normalizados
        self.assertEqual(lista[1]["aplicacao"], "Peça a Deus.")

    def test_registo_vazio_falha(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.json"
            p.write_text(json.dumps({"versiculos": [{"id": 1, "referencia": "", "texto": "x"}]}),
                         encoding="utf-8")
            with self.assertRaises(ValueError):
                vd.carregar_versiculos(p)


class TestIndice(unittest.TestCase):

    def test_rotacao(self) -> None:
        inicio = datetime.date(2026, 11, 28)
        self.assertEqual(vd.indice_do_dia(inicio, inicio, 1826), 0)
        self.assertEqual(vd.indice_do_dia(inicio + datetime.timedelta(days=1), inicio, 1826), 1)
        self.assertEqual(vd.indice_do_dia(inicio + datetime.timedelta(days=1826), inicio, 1826), 0)
        self.assertEqual(vd.indice_do_dia(inicio - datetime.timedelta(days=3), inicio, 1826), 0)


class TestFormatacao(unittest.TestCase):

    V = {"referencia": "Salmos 23:1-3", "texto": "O Senhor é o meu pastor (nada me faltará).",
         "tema": "Ânimo e Fortaleza", "aplicacao": ""}
    HOJE = datetime.date(2026, 11, 28)  # sábado

    def test_telegram_escapa_mdv2(self) -> None:
        t = vd.formatar_telegram(self.V, self.HOJE)
        self.assertIn("Salmos 23:1\\-3 \\(ARA\\)", t)
        self.assertIn("\\(nada me faltará\\)\\.", t)
        self.assertIn("\\#Ânimo\\_e\\_Fortaleza", t)
        self.assertIn("Sábado, 28 de Novembro", t)

    def test_whatsapp_sem_escapes(self) -> None:
        w = vd.formatar_whatsapp(self.V, self.HOJE)
        self.assertNotIn("\\", w)
        self.assertIn("*Salmos 23:1-3 (ARA)*", w)
        self.assertIn("#Ânimo_e_Fortaleza", w)


if __name__ == "__main__":
    unittest.main()
