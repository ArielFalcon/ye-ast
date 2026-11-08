package shop;
import org.springframework.data.jpa.repository.JpaRepository;
class Order {}
interface Base<T> extends JpaRepository<T, Long> {}
interface Orders extends Base<Order> {
 Order findByCode(long code);
 default void custom() { System.out.println("code"); }
 default Order save(Order o) { return o; }
}
interface Inherited extends Base<Order> {}
class Service {
 void run(Inherited base, Orders orders, Order o) { base.save(o);
 base.findById(1L);
 orders.findByCode(1L);
 orders.save(o); orders.custom(); o.getName(); }
}
