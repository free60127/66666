import sys
import pymupdf
from rapidocr_onnxruntime import RapidOCR

pdf = pymupdf.open(sys.argv[1])
ocr = RapidOCR()
for i in range(min(12, len(pdf))):
    pix = pdf[i].get_pixmap(matrix=pymupdf.Matrix(1.2, 1.2), alpha=False)
    result, _ = ocr(pix.tobytes('png'))
    print(f'--- PAGE {i + 1} ---')
    if result:
        print('\n'.join(item[1] for item in result))
