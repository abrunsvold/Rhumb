import { describe, it, expect } from "vitest";
import { buildSql } from "../src/data/sql.js";

describe("buildSql", () => {
  it("select with where + limit parameterizes values", () => {
    expect(buildSql({ kind: "select", table: "users", where: { id: 5, name: "a" }, limit: 10 })).toEqual({
      text: 'SELECT * FROM "users" WHERE "id" = $1 AND "name" = $2 LIMIT $3',
      params: [5, "a", 10],
    });
  });

  it("select without where", () => {
    expect(buildSql({ kind: "select", table: "users" })).toEqual({ text: 'SELECT * FROM "users"', params: [] });
  });

  it("insert", () => {
    expect(buildSql({ kind: "insert", table: "t", values: { a: 1, b: "x" } })).toEqual({
      text: 'INSERT INTO "t" ("a", "b") VALUES ($1, $2)',
      params: [1, "x"],
    });
  });

  it("update sets then where, in param order", () => {
    expect(buildSql({ kind: "update", table: "t", values: { a: 1 }, where: { id: 7 } })).toEqual({
      text: 'UPDATE "t" SET "a" = $1 WHERE "id" = $2',
      params: [1, 7],
    });
  });

  it("delete", () => {
    expect(buildSql({ kind: "delete", table: "t", where: { id: 7 } })).toEqual({
      text: 'DELETE FROM "t" WHERE "id" = $1',
      params: [7],
    });
  });

  it("rejects an invalid table identifier", () => {
    expect(() => buildSql({ kind: "select", table: "users; drop" })).toThrow(/identifier/);
  });

  it("rejects an invalid column identifier", () => {
    expect(() => buildSql({ kind: "select", table: "t", where: { "a b": 1 } })).toThrow(/identifier/);
  });

  it("requires a where on update and delete", () => {
    expect(() => buildSql({ kind: "update", table: "t", values: { a: 1 }, where: {} })).toThrow(/where/);
    expect(() => buildSql({ kind: "delete", table: "t", where: {} })).toThrow(/where/);
  });

  it("requires values on insert and update", () => {
    expect(() => buildSql({ kind: "insert", table: "t", values: {} })).toThrow(/values/);
    expect(() => buildSql({ kind: "update", table: "t", values: {}, where: { id: 1 } })).toThrow(/values/);
  });
});
