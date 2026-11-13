package app;
class Use {
  void run(Person person, Declared declared, FieldOnly only, NotLombok not, Restricted restricted, Immutable value, Order order, Plain plain, Pair pair) {
    person.getName();
    person.setName("n");
    person.isActive();
    person.isAdmin();
    person.setAdmin(true);
    person.getBoxed();
    person.getId();
    person.setId("y");
    person.getCount();
    person.getMissing();
    declared.getLabel();
    declared.getOther();
    only.getShown();
    only.getHidden();
    only.setWritten("w");
    only.setShown("s");
    not.getName();
    restricted.getName();
    value.getId();
    value.setId("z");
    Order.builder().id("a").owner(null).build().getOwner();
    Order.builder().version(2);
    Order.builder().missing(1);
    order.builder();
    Plain.builder().name("p");
    pair.owner().getName();
    pair.left();
    pair.right();
  }
}
