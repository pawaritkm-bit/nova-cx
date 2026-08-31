import { describe, expect, it } from "vitest";
import { inferCustomerTypeFromCode } from "@/lib/admin/service";

describe("inferCustomerTypeFromCode", () => {
  it("แยก P เป็นบุคคลธรรมดา", () => {
    expect(inferCustomerTypeFromCode("P829")).toBe("individual");
    expect(inferCustomerTypeFromCode(" p001 ")).toBe("individual");
  });

  it("แยก N เป็นนิติบุคคล", () => {
    expect(inferCustomerTypeFromCode("N087")).toBe("company");
    expect(inferCustomerTypeFromCode(" n001 ")).toBe("company");
  });

  it("ไม่เดารหัสอื่น", () => {
    expect(inferCustomerTypeFromCode("C001")).toBeNull();
    expect(inferCustomerTypeFromCode(null)).toBeNull();
  });
});
