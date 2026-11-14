import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { parse, type ParseError } from "jsonc-parser"

test("example config is valid JSONC and documents every schema option", () => {
    const errors: ParseError[] = []
    const example = parse(readFileSync("dcp.example.jsonc", "utf8"), errors, {
        allowTrailingComma: true,
    })
    const schema = JSON.parse(readFileSync("dcp.schema.json", "utf8"))
    assert.deepEqual(errors, [])

    function checkProperties(value: Record<string, unknown>, definition: any, path = "") {
        assert.deepEqual(Object.keys(value).sort(), Object.keys(definition.properties ?? {}).sort(), path)
        for (const [key, property] of Object.entries(definition.properties ?? {})) {
            const name = path ? `${path}.${key}` : key
            assert.ok(Object.hasOwn(value, key), `missing example option ${name}`)
            if ((property as any).properties) {
                checkProperties(value[key] as Record<string, unknown>, property, name)
            }
        }
    }
    checkProperties(example, schema)
})
