import { describe, expect, test } from "vitest";
import { updatePackageVersion } from "../../mlc/clientGenerator/utils/typeSpecUtils";
import { join } from "path";
import { load } from '@npmcli/package-json';

describe('Npm package json', () => {
    test('Replace package version', async () => {
        const packageDirectory = join(__dirname, 'testCases');
        await updatePackageVersion(packageDirectory, '2.0.0');
        const packageJson = await load(packageDirectory);        
        expect(packageJson.content.version).toBe('2.0.0');
    });
});