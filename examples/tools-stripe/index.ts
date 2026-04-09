// =============================================================================
// @model-action-protocol/tools-stripe — Pre-built MAP-compliant Stripe tools
//
// Drop-in Stripe tools with reversal schemas already written.
// Every payment, refund, and subscription action is logged, reviewed,
// and reversible out of the box.
//
// Usage:
//   import { stripeTools } from '@model-action-protocol/tools-stripe';
//   stripeTools.forEach(tool => map.addTool(tool));
//
// That's it. Provenance comes for free.
// =============================================================================

import { z } from "zod";
import {
  defineRestoreTool,
  defineCompensateTool,
  defineEscalateTool,
} from "@model-action-protocol/core";

// ─── Charge a customer ──────────────────────────────────────────────────────
// Strategy: COMPENSATE — charges are reversed via refunds, not state restore

export const chargeCustomer = defineCompensateTool({
  name: "stripe.chargeCustomer",
  description: "Create a payment charge for a customer",
  inputSchema: z.object({
    customerId: z.string(),
    amount: z.number().positive(),
    currency: z.string().default("usd"),
    description: z.string().optional(),
  }),
  execute: async (input) => {
    // In production: const charge = await stripe.charges.create(input);
    return {
      chargeId: `ch_${Date.now()}`,
      amount: input.amount,
      status: "succeeded",
    };
  },
  compensate: async (input, output) => {
    // In production: await stripe.refunds.create({ charge: output.chargeId });
    return {
      refundId: `re_${Date.now()}`,
      chargeId: output.chargeId,
      amount: input.amount,
      status: "refunded",
    };
  },
  compensationDescription: "Issue full refund for the charge",
});

// ─── Update subscription ────────────────────────────────────────────────────
// Strategy: RESTORE — capture current plan before changing, restore on rollback

export const updateSubscription = defineRestoreTool({
  name: "stripe.updateSubscription",
  description: "Update a customer's subscription plan",
  inputSchema: z.object({
    subscriptionId: z.string(),
    newPriceId: z.string(),
    prorate: z.boolean().default(true),
  }),
  execute: async (input) => {
    // In production: await stripe.subscriptions.update(input.subscriptionId, { ... });
    return {
      subscriptionId: input.subscriptionId,
      newPriceId: input.newPriceId,
      status: "active",
    };
  },
  capture: async (input) => {
    // In production: const sub = await stripe.subscriptions.retrieve(input.subscriptionId);
    return {
      subscriptionId: input.subscriptionId,
      previousPriceId: "price_original",
      status: "active",
    };
  },
  restore: async (captured) => {
    // In production: await stripe.subscriptions.update(captured.subscriptionId, { price: captured.previousPriceId });
  },
  captureMethod: "GET /v1/subscriptions/:id",
});

// ─── Wire transfer ──────────────────────────────────────────────────────────
// Strategy: ESCALATE — wire transfers are irreversible, require human approval

export const wireTransfer = defineEscalateTool({
  name: "stripe.wireTransfer",
  description: "Initiate a wire transfer to an external bank account",
  inputSchema: z.object({
    destinationAccountId: z.string(),
    amount: z.number().positive(),
    currency: z.string().default("usd"),
    reference: z.string(),
  }),
  execute: async (input) => {
    // In production: await stripe.transfers.create(input);
    return {
      transferId: `tr_${Date.now()}`,
      amount: input.amount,
      status: "pending",
    };
  },
  approver: "treasury@company.com",
  escalationReason: "Wire transfers are irreversible once settled",
});

// ─── Issue refund ───────────────────────────────────────────────────────────
// Strategy: COMPENSATE — refunds are reversed by creating a new charge

export const issueRefund = defineCompensateTool({
  name: "stripe.issueRefund",
  description: "Issue a refund for a previous charge",
  inputSchema: z.object({
    chargeId: z.string(),
    amount: z.number().positive().optional(), // partial refund
    reason: z.string().optional(),
  }),
  execute: async (input) => {
    // In production: await stripe.refunds.create({ charge: input.chargeId, amount: input.amount });
    return {
      refundId: `re_${Date.now()}`,
      chargeId: input.chargeId,
      status: "succeeded",
    };
  },
  compensate: async (input, output) => {
    // In production: create a new charge for the refunded amount
    return {
      chargeId: `ch_${Date.now()}`,
      note: `Re-charge after refund ${output.refundId} was reversed`,
    };
  },
  compensationDescription: "Re-charge the customer for the reversed refund amount",
});

// ─── Update customer ────────────────────────────────────────────────────────
// Strategy: RESTORE — capture customer record before update

export const updateCustomer = defineRestoreTool({
  name: "stripe.updateCustomer",
  description: "Update customer metadata, email, or payment method",
  inputSchema: z.object({
    customerId: z.string(),
    email: z.string().optional(),
    name: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
  execute: async (input) => {
    // In production: await stripe.customers.update(input.customerId, { ... });
    return { customerId: input.customerId, updated: true };
  },
  capture: async (input) => {
    // In production: const customer = await stripe.customers.retrieve(input.customerId);
    return { customerId: input.customerId, email: "original@email.com", name: "Original Name" };
  },
  restore: async (captured) => {
    // In production: await stripe.customers.update(captured.customerId, captured);
  },
  captureMethod: "GET /v1/customers/:id",
});

// ─── Export all tools ───────────────────────────────────────────────────────

export const stripeTools = [
  chargeCustomer,
  updateSubscription,
  wireTransfer,
  issueRefund,
  updateCustomer,
];
