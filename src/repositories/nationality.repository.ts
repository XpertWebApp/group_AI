import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface NationalityRow {
    code: string;
    name: string | null;
}

/**
 * Read-side access for the `master.nationalities` table.
 *
 * Writes go through `staticDataRepository.upsertNationality()` during the
 * scheduled WBE sync. This module only exposes a fast `findAll()` for the
 * Create Request form dropdown.
 */
export class NationalityRepository {
    /**
     * Return every nationality, ordered alphabetically by `name` (falling
     * back to `code` when the name is null). FE renders this as a
     * searchable dropdown on the Create Request form.
     */
    async findAll(): Promise<NationalityRow[]> {
        const rows = await prisma.nationality.findMany({
            select: { code: true, name: true },
        });
        rows.sort((a, b) => {
            const an = (a.name ?? a.code).toLocaleLowerCase();
            const bn = (b.name ?? b.code).toLocaleLowerCase();
            return an.localeCompare(bn);
        });
        return rows;
    }

    /** Count rows — used by the controller to detect the empty-table case. */
    async count(): Promise<number> {
        return prisma.nationality.count();
    }
}

export default new NationalityRepository();
