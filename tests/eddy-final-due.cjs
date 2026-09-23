const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const Papa = require('papaparse')
const ts = require('typescript')

const csvPath = process.argv[2]
if (!csvPath) throw new Error('Pass the Eddy Statements List CSV path')

const source = fs.readFileSync(path.join(__dirname, '../src/lib/utils/eddyFinalDue.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const moduleUnderTest = new Module.Module('eddyFinalDue', module)
moduleUnderTest._compile(compiled, 'eddyFinalDue.js')
const { effectiveEddyFinalDue, futureEddyOpeningCarryover, isEddyFeatureContract } = moduleUnderTest.exports

const rows = Papa.parse(fs.readFileSync(csvPath, 'utf8'), { header: true, skipEmptyLines: true }).data
  .filter(row => row['Period Ref'] === 'H1 2026')
  .map(row => ({
    periodRef: row['Period Ref'], contractId: row['Contract ID'],
    contractName: row['Contract Name'], payeeId: row['Payee ID'],
    payeeName: row['Payee Name'], splitPercent: Number(row['Payee Split %']),
    finalDue: Number(row['Final Due']), netPayeeSubtotal: Number(row['Net Payee Subtotal']),
  }))

function check(contractId, payeeName, amount, source, verify = false) {
  const row = rows.find(item => item.contractId === contractId && item.payeeName === payeeName)
  assert.ok(row, `${contractId} ${payeeName} exists`)
  const result = effectiveEddyFinalDue(row, rows)
  assert.ok(Math.abs(result.amount - amount) < 0.000001, `${contractId} ${payeeName} amount`)
  assert.equal(result.source, source, `${contractId} ${payeeName} source`)
  assert.equal(result.needsVerification, verify, `${contractId} ${payeeName} verification`)
  return result.amount
}

assert.equal(rows.length, 162)
for (const name of ['Courtney Bennett', 'Mike Brainchild', 'Sunny Kale']) {
  check('192368', name, rows.find(row => row.contractId === '192368' && row.payeeName === name).finalDue, 'feature-contract protected')
}
for (const name of ['Alika McGillivary', 'Nabiha Bensouda']) {
  check('192631', name, rows.find(row => row.contractId === '192631' && row.payeeName === name).finalDue, 'feature-contract protected')
}
check('399496', 'Argento Dust', -648.437896957, 'shared-deficit corrected')
check('399496', 'Nduduzo Khayelihle Ngcubo', -648.437896957, 'shared-deficit corrected')
check('399497', 'Cassia Begg', -303.935383977, 'shared-deficit corrected')
check('399497', 'Shahin Shantiaei', -303.935383977, 'shared-deficit corrected')
check('379441', 'Aahil Kanji', -365.141217617, 'shared-deficit corrected')
check('379441', 'David Vioque', -365.141217617, 'shared-deficit corrected')
check('374299', 'ANTOINE BONOMI', -77.1449292875, 'shared-deficit corrected')
check('374299', 'Tanguy Paumier', -77.1449292875, 'shared-deficit corrected')
check('384774', 'Akaash Patel', -185.4267904575, 'shared-deficit corrected')
check('384774', 'Zviratidzo Msipha', -185.4267904575, 'shared-deficit corrected')
check('384775', 'Akaash Patel', -116.69, 'shared-deficit corrected')
check('384775', 'Emmanuel Jal', -116.69, 'shared-deficit corrected')
check('384496', 'Stephane Claire Tailliez', -732.72, 'shared-deficit corrected')
check('399494', 'Pablo TBC', -135.62743092275, 'shared-deficit corrected')
check('399494', 'Julien TBC', -135.62743092275, 'shared-deficit corrected')
check('399494', 'Sonlam TBC', -27.12548618455, 'shared-deficit corrected')
check('399494', 'Pauline Bougare', -135.62743092275, 'shared-deficit corrected')
check('399494', 'Remi Nicolett', -108.5019447382, 'shared-deficit corrected')
check('192433', 'Alika McGillivary', -122.130674032, 'raw')
check('192433', 'Robin Maichner', -43.104943774, 'raw')
check('192302', 'Robin Maichner', 48.939122439, 'raw')
check('192865', 'Max Reich', -356.9189821, 'raw')
check('399492', 'Hyenah Music', -337.2988950265, 'shared-deficit corrected')
check('399492', 'David Mayer', -337.2988950265, 'shared-deficit corrected')
check('399493', 'Eli Fola', -376.31869007, 'shared-deficit corrected')
check('399493', 'Sanvero Music', -376.31869007, 'shared-deficit corrected')
check('379447', 'Huw Mitchell', -103.76333354086, 'shared-deficit corrected')
check('379447', 'Antoine Woreczek', -103.76333322957, 'shared-deficit corrected')
check('379447', 'Soukaina Harrar', -103.76333322957, 'shared-deficit corrected')
check('374303', 'Andile Nkosana', -33.93097444975, 'shared-deficit corrected')
check('374303', 'Robin Maichner', -101.79292334925, 'shared-deficit corrected')

const alika = rows.filter(row => row.payeeName === 'Alika McGillivary')
assert.equal(alika.length, 6)
const alikaClosing = 28.63 + alika.reduce((sum, row) => sum + effectiveEddyFinalDue(row, rows).amount, 0)
assert.ok(Math.abs(alikaClosing - -491.994220951) < 0.000001)

const argento = rows.find(row => row.contractId === '399496')
assert.equal(effectiveEddyFinalDue({ ...argento, manualOverride: -123.45 }, rows).amount, -123.45)
assert.equal(effectiveEddyFinalDue({ ...argento, manualOverride: -123.45 }, rows).source, 'manual override')
assert.equal(effectiveEddyFinalDue({ ...argento, finalDue: -0.000003686, contractId: 'dust' }, rows).amount, 0)
for (const name of ['Test Feat Artist', 'Test Featured Artist', 'Test Feature Contract', 'Test (FAC)']) {
  assert.equal(isEddyFeatureContract(name), true)
}
assert.equal(isEddyFeatureContract('Alika - Face Front EP'), false)
assert.equal(futureEddyOpeningCarryover(-29.79), 0)
assert.equal(futureEddyOpeningCarryover(60), 60)
assert.equal(futureEddyOpeningCarryover(99.99), 99.99)
assert.equal(futureEddyOpeningCarryover(100), 0)
assert.equal(futureEddyOpeningCarryover(150), 0)
assert.equal(futureEddyOpeningCarryover(0), 0)

console.log(`H1: ${rows.length} rows; Alika closing ${alikaClosing.toFixed(2)}; PIYS, Night Whispers, Liquid Light, What If You Fly, Losing You, First Sign, Dommage, Mezcla, CLARAA, Casa Bap, Cala Comte, named cases, override, feature matching, dust and six future carryover boundaries passed`)
