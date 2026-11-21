import { requireAdminPage } from "@/lib/admin/page";
import { Flash, PageHead } from "@/components/admin/ui";
import { ProductForm } from "../ProductForm";

export default async function NewProduct({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  await requireAdminPage("products.manage", "/admin/products/new");
  return (
    <>
      <PageHead title="Новый товар" />
      <Flash error={sp.error} />
      <ProductForm />
    </>
  );
}
