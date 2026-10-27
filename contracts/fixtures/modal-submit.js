// Canonical valid modal-submit callback payload. Note the `values` key (object
// map of field name -> submitted value): this is the wire contract. A
// payload keyed `fields` is non-conforming.
export const modalSubmitFixture = {
  message_id: "msg-ghi789",
  modal_id: "edit-draft:vr-9c1d",
  user_id: "69276926-7182-4920-a849-fc6f27dc049b",
  display_name: "Brian",
  values: {
    subject: "Re: April invoice - updated",
    body: "Hi, attaching the revised April statement. Maxwell",
  },
  timestamp: 1716740000000,
};
