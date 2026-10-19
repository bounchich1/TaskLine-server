import { zip } from './zip.js';

export type Cell = string | number | null;

export interface Table {
    title: string;
    columns: string[];
    rows: Cell[][];
}

const CSV_SEPARATOR = ';';
const BOM = '﻿';

function csvCell(cell: Cell): string {
    if (cell === null) {
        return '';
    }

    const text = typeof cell === 'number' ? String(cell).replace('.', ',') : cell;

    return /[;"\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(table: Table): string {
    const lines = [table.columns, ...table.rows].map((row) => row.map(csvCell).join(CSV_SEPARATOR));

    return `${BOM}${lines.join('\r\n')}\r\n`;
}

function escapeXml(text: string): string {
    return (
        text
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            // eslint-disable-next-line no-control-regex
            .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    );
}

function columnName(index: number): string {
    let name = '';

    for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
        name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
    }

    return name;
}

function xmlCell(cell: Cell, reference: string, style: number): string {
    if (cell === null) {
        return '';
    }

    if (typeof cell === 'number' && Number.isFinite(cell)) {
        return `<c r="${reference}" s="${style}"><v>${cell}</v></c>`;
    }

    return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell))}</t></is></c>`;
}

function sheetXml(table: Table): string {
    const rows = [table.columns, ...table.rows].map((row, rowIndex) => {
        const cells = row.map((cell, column) =>
            xmlCell(cell, `${columnName(column)}${rowIndex + 1}`, rowIndex ? 0 : 1),
        );

        return `<row r="${rowIndex + 1}">${cells.join('')}</row>`;
    });

    const widths = table.columns
        .map(
            (column, index) =>
                `<col min="${index + 1}" max="${index + 1}" width="${Math.max(12, column.length + 4)}" customWidth="1"/>`,
        )
        .join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`;

export function toXlsx(table: Table): Buffer {
    const sheetName = escapeXml(table.title.replaceAll(/[\\/?*[\]:]/g, ' ').slice(0, 31));

    return zip({
        '[Content_Types].xml': CONTENT_TYPES,
        '_rels/.rels': ROOT_RELS,
        'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
        'xl/styles.xml': STYLES,
        'xl/worksheets/sheet1.xml': sheetXml(table),
    });
}
