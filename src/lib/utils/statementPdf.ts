import {
  buildPrintableHTMLDocument,
  type StatementOutputData,
} from '@/lib/utils/outputGenerator'

const PDF_PAGE_WIDTH = 595.28
const PDF_PAGE_HEIGHT = 841.89
const PDF_PAGE_MARGIN = 24
const RENDER_WIDTH_PX = 980
const RENDER_SCALE = 2

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? ''
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0))
}

function buildSvgRenderableFragment(htmlDocument: string): string {
  const parser = new DOMParser()
  const parsed = parser.parseFromString(htmlDocument, 'text/html')
  const styleMarkup = Array.from(parsed.head.querySelectorAll('style'))
    .map(node => node.outerHTML)
    .join('\n')
  const bodyMarkup = parsed.body?.innerHTML?.trim() ?? ''
  return `
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:${RENDER_WIDTH_PX}px;background:#ffffff;color:#1a1a1a;">
      ${styleMarkup}
      ${bodyMarkup}
    </div>
  `
}

function loadImageFromSvg(svgMarkup: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to render statement print HTML to image.'))
    }
    image.src = url
  })
}

async function measurePrintableHeight(htmlDocument: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe')
    iframe.style.position = 'fixed'
    iframe.style.left = '-10000px'
    iframe.style.top = '0'
    iframe.style.width = `${RENDER_WIDTH_PX}px`
    iframe.style.height = '10px'
    iframe.style.opacity = '0'
    iframe.style.pointerEvents = 'none'
    iframe.setAttribute('aria-hidden', 'true')

    const cleanup = () => {
      iframe.onload = null
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
    }

    iframe.onload = () => {
      window.setTimeout(() => {
        try {
          const doc = iframe.contentDocument
          if (!doc) throw new Error('Printable statement document did not load.')
          const bodyHeight = doc.body?.scrollHeight ?? 0
          const documentHeight = doc.documentElement?.scrollHeight ?? 0
          resolve(Math.max(bodyHeight, documentHeight, 1123))
        } catch (error) {
          reject(error)
        } finally {
          cleanup()
        }
      }, 80)
    }

    document.body.appendChild(iframe)
    iframe.srcdoc = htmlDocument
  })
}

async function renderPrintableCanvas(data: StatementOutputData): Promise<HTMLCanvasElement> {
  const htmlDocument = buildPrintableHTMLDocument(data)
  const renderHeight = await measurePrintableHeight(htmlDocument)
  const xhtmlFragment = buildSvgRenderableFragment(htmlDocument)
  const svgMarkup = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${RENDER_WIDTH_PX}" height="${renderHeight}">
      <rect width="100%" height="100%" fill="#ffffff"></rect>
      <foreignObject width="100%" height="100%">${xhtmlFragment}</foreignObject>
    </svg>
  `
  const image = await loadImageFromSvg(svgMarkup)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(RENDER_WIDTH_PX * RENDER_SCALE)
  canvas.height = Math.round(renderHeight * RENDER_SCALE)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Failed to create PDF render canvas.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0)
  context.drawImage(image, 0, 0, RENDER_WIDTH_PX, renderHeight)
  return canvas
}

function sliceCanvasIntoPages(canvas: HTMLCanvasElement) {
  const printableWidth = PDF_PAGE_WIDTH - (PDF_PAGE_MARGIN * 2)
  const printableHeight = PDF_PAGE_HEIGHT - (PDF_PAGE_MARGIN * 2)
  const sliceHeightPx = Math.max(
    1,
    Math.floor(canvas.width * (printableHeight / printableWidth))
  )

  const pages: Array<{ jpegBytes: Uint8Array; width: number; height: number }> = []
  for (let offsetY = 0; offsetY < canvas.height; offsetY += sliceHeightPx) {
    const currentHeight = Math.min(sliceHeightPx, canvas.height - offsetY)
    const pageCanvas = document.createElement('canvas')
    pageCanvas.width = canvas.width
    pageCanvas.height = currentHeight
    const context = pageCanvas.getContext('2d')
    if (!context) throw new Error('Failed to create PDF page canvas.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
    context.drawImage(
      canvas,
      0,
      offsetY,
      canvas.width,
      currentHeight,
      0,
      0,
      pageCanvas.width,
      pageCanvas.height
    )
    pages.push({
      jpegBytes: dataUrlToBytes(pageCanvas.toDataURL('image/jpeg', 0.92)),
      width: pageCanvas.width,
      height: pageCanvas.height,
    })
  }
  return pages
}

function buildPdfFromJpegPages(pages: Array<{ jpegBytes: Uint8Array; width: number; height: number }>): Uint8Array {
  const parts: Uint8Array[] = []
  const offsets: number[] = [0]
  const pageObjectNumbers: number[] = []
  let cursor = 0

  const pushPart = (part: Uint8Array) => {
    parts.push(part)
    cursor += part.length
  }

  const objectNumbers = {
    catalog: 1,
    pages: 2,
  }
  let nextObjectNumber = 3

  pushPart(encodeText('%PDF-1.4\n'))

  const writeObject = (objectNumber: number, body: Uint8Array) => {
    offsets[objectNumber] = cursor
    pushPart(encodeText(`${objectNumber} 0 obj\n`))
    pushPart(body)
    pushPart(encodeText('\nendobj\n'))
  }

  const pageEntries: Array<{ page: number; content: number; image: number }> = []
  for (const _page of pages) {
    pageEntries.push({
      page: nextObjectNumber++,
      content: nextObjectNumber++,
      image: nextObjectNumber++,
    })
  }

  const kids = pageEntries.map(entry => `${entry.page} 0 R`).join(' ')
  writeObject(
    objectNumbers.catalog,
    encodeText(`<< /Type /Catalog /Pages ${objectNumbers.pages} 0 R >>`)
  )
  writeObject(
    objectNumbers.pages,
    encodeText(`<< /Type /Pages /Kids [${kids}] /Count ${pageEntries.length} >>`)
  )

  pages.forEach((page, index) => {
    const refs = pageEntries[index]
    const printableWidth = PDF_PAGE_WIDTH - (PDF_PAGE_MARGIN * 2)
    const renderedHeight = printableWidth * (page.height / page.width)
    const y = PDF_PAGE_HEIGHT - PDF_PAGE_MARGIN - renderedHeight
    const contentStream = `q\n${printableWidth.toFixed(2)} 0 0 ${renderedHeight.toFixed(2)} ${PDF_PAGE_MARGIN.toFixed(2)} ${y.toFixed(2)} cm\n/Im${index + 1} Do\nQ`
    const contentBytes = encodeText(contentStream)
    writeObject(
      refs.page,
      encodeText(
        `<< /Type /Page /Parent ${objectNumbers.pages} 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH.toFixed(2)} ${PDF_PAGE_HEIGHT.toFixed(2)}] /Resources << /XObject << /Im${index + 1} ${refs.image} 0 R >> >> /Contents ${refs.content} 0 R >>`
      )
    )
    writeObject(
      refs.content,
      encodeText(`<< /Length ${contentBytes.length} >>\nstream\n${contentStream}\nendstream`)
    )

    offsets[refs.image] = cursor
    pushPart(encodeText(`${refs.image} 0 obj\n`))
    pushPart(
      encodeText(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.length} >>\nstream\n`
      )
    )
    pushPart(page.jpegBytes)
    pushPart(encodeText('\nendstream\nendobj\n'))
  })

  const xrefOffset = cursor
  pushPart(encodeText(`xref\n0 ${nextObjectNumber}\n`))
  pushPart(encodeText('0000000000 65535 f \n'))
  for (let objectNumber = 1; objectNumber < nextObjectNumber; objectNumber++) {
    pushPart(encodeText(`${String(offsets[objectNumber] ?? 0).padStart(10, '0')} 00000 n \n`))
  }
  pushPart(
    encodeText(
      `trailer << /Size ${nextObjectNumber} /Root ${objectNumbers.catalog} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
    )
  )

  const totalLength = parts.reduce((sum, part) => sum + part.length, 0)
  const pdfBytes = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    pdfBytes.set(part, offset)
    offset += part.length
  }
  return pdfBytes
}

export async function generateStatementPdf(data: StatementOutputData): Promise<Uint8Array> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Statement PDF generation requires a browser environment.')
  }

  const canvas = await renderPrintableCanvas(data)
  const pages = sliceCanvasIntoPages(canvas)
  if (pages.length === 0) {
    throw new Error('No statement content was available to render.')
  }
  return buildPdfFromJpegPages(pages)
}
